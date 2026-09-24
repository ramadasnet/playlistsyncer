// Adapt SoundCloud playlists and tracks to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {providerFetch} from "./http"
import {findBestTrackMatch, searchableTitle} from "./matching"
import {trackIdsForProvider} from "./track-ids"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiBase = "https://api.soundcloud.com"
const playlistUrnPattern = /^soundcloud:playlists:\d+$/
const trackUrnPattern = /^soundcloud:tracks:\d+$/

interface SoundCloudUser {
    username?: string
}

interface SoundCloudTrack {
    urn?: string
    uri?: string
    title?: string
    duration?: number
    artwork_url?: string
    isrc?: string
    metadata_artist?: string
    release?: string
    user?: SoundCloudUser
}

interface SoundCloudPlaylist {
    urn?: string
    uri?: string
    title?: string
    description?: string | null
    artwork_url?: string
    track_count?: number
    kind?: string
}

interface SoundCloudPage<T> {
    collection?: T[]
    next_href?: string | null
}

// SoundCloud accepts JSON and documents this Accept value on every call.
const soundCloudHeaders = (body?: boolean): HeadersInit => ({
    Accept: "application/json; charset=utf-8",
    ...(body ? {"Content-Type": "application/json"} : {})
})

// Perform an authenticated SoundCloud request with the documented JSON headers.
function soundCloudFetch<T>(account: ProviderAccountDocument, url: string, init: RequestInit = {}): Promise<T> {
    return providerFetch<T>(account, url, {
        ...init,
        headers: soundCloudHeaders(Boolean(init.body))
    })
}

// Keep URN path segments intact; other ids are encoded.
function resourcePath(id: string): string {
    return playlistUrnPattern.test(id) || trackUrnPattern.test(id) ? id : encodeURIComponent(id)
}

// Normalize a track URN from the identifier SoundCloud returned.
function trackUrnFrom(track: SoundCloudTrack): string | undefined {
    if (track.urn && trackUrnPattern.test(track.urn)) {
        return track.urn
    }
    const match = track.uri?.match(/\/tracks\/(?:soundcloud:tracks:)?(\d+)(?:$|[/?#])/)
    return match ? `soundcloud:tracks:${match[1]}` : undefined
}

// Normalize a playlist URN from the identifier SoundCloud returned.
function playlistUrnFrom(playlist: SoundCloudPlaylist): string | undefined {
    if (playlist.urn && playlistUrnPattern.test(playlist.urn)) {
        return playlist.urn
    }
    const match = playlist.uri?.match(/\/playlists\/(?:soundcloud:playlists:)?(\d+)(?:$|[/?#])/)
    return match ? `soundcloud:playlists:${match[1]}` : undefined
}

// Follow linked_partitioning cursors until the collection is exhausted.
async function collectPages<T>(account: ProviderAccountDocument, url: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = url
    while (next) {
        const page: SoundCloudPage<T> | T[] = await soundCloudFetch(account, next)
        if (Array.isArray(page)) {
            items.push(...page)
            return items
        }
        items.push(...(page.collection || []))
        next = page.next_href || undefined
    }
    return items
}

// Convert a SoundCloud track into the shared track representation.
function mapTrack(track: SoundCloudTrack, itemId?: string): ProviderTrack | undefined {
    const urn = trackUrnFrom(track)
    if (!urn) {
        return undefined
    }
    const artist = track.metadata_artist?.trim() || track.user?.username?.trim()
    return {
        itemId: itemId || urn,
        trackId: urn,
        title: track.title?.trim() || "Untitled track",
        artists: artist ? [artist] : [],
        album: track.release?.trim() || undefined,
        durationMs: track.duration && track.duration > 0 ? track.duration : undefined,
        isrc: track.isrc?.trim() || undefined,
        imageUrl: track.artwork_url?.trim() || undefined
    }
}

// SoundCloud playlist membership is replaced as a whole, using track URNs.
function replacePlaylistTracks(account: ProviderAccountDocument, playlistId: string, urns: string[]): Promise<unknown> {
    return soundCloudFetch(account, `${apiBase}/playlists/${resourcePath(playlistId)}`, {
        method: "PUT",
        body: JSON.stringify({playlist: {tracks: urns.map((urn) => ({urn}))}})
    })
}

function asPlaylist(playlist: SoundCloudPlaylist): ProviderPlaylist | undefined {
    const id = playlistUrnFrom(playlist)
    if (!id || (playlist.kind && playlist.kind !== "playlist")) {
        return undefined
    }
    return {
        id,
        name: playlist.title?.trim() || `Untitled playlist (${id})`,
        description: playlist.description ?? "",
        imageUrl: playlist.artwork_url?.trim() || undefined,
        itemCount: playlist.track_count ?? 0
    }
}

// Search playable catalog tracks. SoundCloud has no ISRC filter, so an ISRC is a text query.
async function searchTracks(account: ProviderAccountDocument, query: string): Promise<ProviderTrack[]> {
    const params = new URLSearchParams({
        q: query,
        access: "playable",
        limit: "10",
        linked_partitioning: "true"
    })
    const tracks = await collectPages<SoundCloudTrack>(account, `${apiBase}/tracks?${params.toString()}`)
    return tracks.flatMap((track) => {
        const mapped = mapTrack(track)
        return mapped ? [mapped] : []
    })
}

// SoundCloud adapter. Playlist writes send the full track list because the API has no item-level add or remove.
export const soundcloudAdapter: ProviderAdapter = {
    provider: "soundcloud",
    async listPlaylists(account) {
        const params = new URLSearchParams({
            show_tracks: "false",
            linked_partitioning: "true",
            limit: "50"
        })
        const playlists = await collectPages<SoundCloudPlaylist>(account, `${apiBase}/me/playlists?${params.toString()}`)
        return playlists.flatMap((playlist) => {
            const mapped = asPlaylist(playlist)
            return mapped ? [mapped] : []
        })
    },
    async createPlaylist(account, name, description) {
        const playlist = await soundCloudFetch<SoundCloudPlaylist>(account, `${apiBase}/playlists`, {
            method: "POST",
            body: JSON.stringify({
                playlist: {
                    title: name,
                    description: description ?? "",
                    sharing: "private",
                    tracks: []
                }
            })
        })
        const mapped = asPlaylist(playlist)
        if (!mapped) {
            throw createError({
                statusCode: 502,
                statusMessage: "SoundCloud playlist creation returned an unexpected payload"
            })
        }
        return mapped
    },
    async deletePlaylist(account, playlistId) {
        await soundCloudFetch(account, `${apiBase}/playlists/${resourcePath(playlistId)}`, {method: "DELETE"})
    },
    async getPlaylistItems(account, playlistId) {
        const tracks = await collectPages<SoundCloudTrack>(account, `${apiBase}/playlists/${resourcePath(playlistId)}/tracks?linked_partitioning=true`)
        return tracks.flatMap((track, index) => {
            const urn = trackUrnFrom(track)
            const mapped = urn ? mapTrack(track, `${urn}:${index}`) : undefined
            return mapped ? [mapped] : []
        })
    },
    async searchTrackCandidates(account, track) {
        if (track.isrc) {
            const byIsrc = await searchTracks(account, track.isrc)
            if (byIsrc.some((candidate) => candidate.isrc === track.isrc)) {
                return byIsrc
            }
        }
        const query = [track.artists[0], searchableTitle(track.title)].filter(Boolean).join(" ").trim()
        if (!query || query === track.isrc) {
            return []
        }
        return searchTracks(account, query)
    },
    async searchTrack(account, track) {
        return findBestTrackMatch(track, await this.searchTrackCandidates(account, track))
    },
    async getTrackDurations(account, trackIds) {
        const durations = new Map<string, number>()
        const ids = trackIdsForProvider("soundcloud", trackIds)
        for (let index = 0; index < ids.length; index += 50) {
            const batch = ids.slice(index, index + 50)
            const params = new URLSearchParams({
                urns: batch.join(","),
                linked_partitioning: "true",
                limit: String(batch.length)
            })
            const tracks = await collectPages<SoundCloudTrack>(account, `${apiBase}/tracks?${params.toString()}`)
            for (const track of tracks) {
                const mapped = mapTrack(track)
                if (mapped?.durationMs) {
                    durations.set(mapped.trackId, mapped.durationMs)
                }
            }
        }
        return durations
    },
    async addTracks(account, playlistId, trackIds, onAdded) {
        const additions = trackIds.filter((trackId) => trackUrnPattern.test(trackId))
        if (!additions.length) {
            return
        }
        const current = await this.getPlaylistItems(account, playlistId)
        await replacePlaylistTracks(account, playlistId, [...current.map((track) => track.trackId), ...additions])
        await onAdded?.(additions.map((providerTrackId) => ({providerTrackId})))
    },
    async removePlaylistItems(account, playlistId, itemIds, onRemoved) {
        const requested = new Set(itemIds)
        if (!requested.size) {
            return
        }
        const current = await this.getPlaylistItems(account, playlistId)
        const removed: string[] = []
        const remaining: string[] = []
        for (const track of current) {
            if (requested.has(track.itemId)) {
                removed.push(track.itemId)
            } else {
                remaining.push(track.trackId)
            }
        }
        if (!removed.length) {
            return
        }
        await replacePlaylistTracks(account, playlistId, remaining)
        await onRemoved?.(removed)
    }
}
