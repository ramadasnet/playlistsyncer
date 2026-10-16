// Adapt SoundCloud playlists and tracks to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {providerFetch} from "./http"
import {catalogSearchQuery, findBestTrackMatch} from "./matching"
import {isProviderTrackId, trackIdsForProvider} from "./track-ids"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiBase = "https://api.soundcloud.com"
const playlistUrnPattern = /^soundcloud:playlists:\d+$/
const searchCandidateLimit = 10

// Track URNs use the catalog pattern shared with duration lookups.
function isTrackUrn(id: string): boolean {
    return isProviderTrackId("soundcloud", id)
}

interface SoundCloudUser {
    username?: string
}

interface SoundCloudTrack {
    urn?: string
    uri?: string
    title?: string
    duration?: number
    artwork_url?: string
    permalink_url?: string
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
    return playlistUrnPattern.test(id) || isTrackUrn(id) ? id : encodeURIComponent(id)
}

// Normalize a track URN from the identifier SoundCloud returned.
function trackUrnFrom(track: SoundCloudTrack): string | undefined {
    if (track.urn && isTrackUrn(track.urn)) {
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
    const url = track.permalink_url?.trim()
    return {
        itemId: itemId || urn,
        trackId: urn,
        title: track.title?.trim() || "Untitled track",
        artists: artist ? [artist] : [],
        album: track.release?.trim() || undefined,
        durationMs: track.duration && track.duration > 0 ? track.duration : undefined,
        isrc: track.isrc?.trim() || undefined,
        imageUrl: track.artwork_url?.trim() || undefined,
        ...(url?.startsWith("https://soundcloud.com/") ? {url} : {})
    }
}

// SoundCloud playlist membership is replaced as a whole, using track URNs.
function replacePlaylistTracks(account: ProviderAccountDocument, playlistId: string, urns: string[]): Promise<unknown> {
    return soundCloudFetch(account, `${apiBase}/playlists/${resourcePath(playlistId)}`, {
        method: "PUT",
        body: JSON.stringify({playlist: {tracks: urns.map((urn) => ({urn}))}})
    })
}

// One full-list replacement per playlist in this process. Separate task leases do not cover the same playlist.
const playlistWriteTails = new Map<string, Promise<unknown>>()

function withPlaylistWrite<T>(playlistId: string, operation: () => Promise<T>): Promise<T> {
    const previous = playlistWriteTails.get(playlistId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    playlistWriteTails.set(playlistId, run)
    return run.finally(() => {
        if (playlistWriteTails.get(playlistId) === run) {
            playlistWriteTails.delete(playlistId)
        }
    })
}

// Read playlist membership without dropping entries that cannot be written back.
async function loadPlaylistTracks(account: ProviderAccountDocument, playlistId: string): Promise<{tracks: ProviderTrack[]; unmapped: number}> {
    const raw = await collectPages<SoundCloudTrack>(account, `${apiBase}/playlists/${resourcePath(playlistId)}/tracks?linked_partitioning=true`)
    let unmapped = 0
    const tracks = raw.flatMap((track, index) => {
        const urn = trackUrnFrom(track)
        if (!urn) {
            unmapped += 1
            return []
        }
        const mapped = mapTrack(track, `${urn}:${index}`)
        return mapped ? [mapped] : []
    })
    return {tracks, unmapped}
}

// Refuse a full-list write that would delete entries we cannot represent.
function assertPlaylistReplaceable(unmapped: number) {
    if (unmapped > 0) {
        throw createError({
            statusCode: 502,
            statusMessage: "SoundCloud playlist has entries that cannot be updated safely"
        })
    }
}

// Item ids are `urn:index` from an earlier read. Another replacement shifts those indexes,
// so a removal matches the track URN and only as many copies as were requested.
function removalTargets(itemIds: string[]): Map<string, string[]> {
    const targets = new Map<string, string[]>()
    for (const itemId of itemIds) {
        const separator = itemId.lastIndexOf(":")
        const urn = separator > 0 ? itemId.slice(0, separator) : ""
        if (!isTrackUrn(urn)) {
            continue
        }
        const queued = targets.get(urn)
        if (queued) {
            queued.push(itemId)
        } else {
            targets.set(urn, [itemId])
        }
    }
    return targets
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

// Search one page of playable tracks. SoundCloud has no ISRC filter, so an ISRC is a text query.
async function searchTracks(account: ProviderAccountDocument, query: string): Promise<ProviderTrack[]> {
    const params = new URLSearchParams({
        q: query,
        access: "playable",
        limit: String(searchCandidateLimit),
        linked_partitioning: "true"
    })
    const page = await soundCloudFetch<SoundCloudPage<SoundCloudTrack> | SoundCloudTrack[]>(account, `${apiBase}/tracks?${params.toString()}`)
    const tracks = (Array.isArray(page) ? page : page.collection || []).slice(0, searchCandidateLimit)
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
        const {tracks} = await loadPlaylistTracks(account, playlistId)
        return tracks
    },
    async searchTrackCandidates(account, track) {
        if (track.isrc) {
            const byIsrc = await searchTracks(account, track.isrc)
            if (byIsrc.some((candidate) => candidate.isrc === track.isrc)) {
                return byIsrc
            }
        }
        const query = catalogSearchQuery("soundcloud", track)
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
        const additions = trackIds.filter((trackId) => isTrackUrn(trackId))
        if (!additions.length) {
            return
        }
        await withPlaylistWrite(playlistId, async () => {
            const {tracks, unmapped} = await loadPlaylistTracks(account, playlistId)
            assertPlaylistReplaceable(unmapped)
            await replacePlaylistTracks(account, playlistId, [...tracks.map((track) => track.trackId), ...additions])
            await onAdded?.(additions.map((providerTrackId) => ({providerTrackId})))
        })
    },
    async removePlaylistItems(account, playlistId, itemIds, onRemoved) {
        const targets = removalTargets(itemIds)
        if (!targets.size) {
            return
        }
        await withPlaylistWrite(playlistId, async () => {
            const {tracks, unmapped} = await loadPlaylistTracks(account, playlistId)
            assertPlaylistReplaceable(unmapped)
            const removed: string[] = []
            const remaining: string[] = []
            for (const track of tracks) {
                const itemId = targets.get(track.trackId)?.shift()
                if (itemId) {
                    removed.push(itemId)
                } else {
                    remaining.push(track.trackId)
                }
            }
            if (!removed.length) {
                return
            }
            await replacePlaylistTracks(account, playlistId, remaining)
            await onRemoved?.(removed)
        })
    }
}
