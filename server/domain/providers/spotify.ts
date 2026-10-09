// Adapt Spotify playlist operations to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {providerFetch} from "./http"
import {findBestTrackMatch, searchableTitle} from "./matching"
import {trackIdsForProvider} from "./track-ids"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiBase = "https://api.spotify.com/v1"
const descriptionMaxLength = 300

// Spotify stores omitted descriptions as null, so always send a string and stay within the API limit.
function createDescription(description?: string): string {
    return (description ?? "").slice(0, descriptionMaxLength)
}

interface SpotifyTrack {
    id: string
    uri: string
    name: string
    artists: {name: string}[]
    album?: {name: string; images?: {url: string}[]}
    duration_ms?: number
    external_ids?: {isrc?: string}
}

// Follow Spotify continuation URLs until all items are collected.
async function collectPages<T>(account: ProviderAccountDocument, url: string): Promise<T[]> {
    const items: T[] = []
    let next: string | null = url
    while (next) {
        const page: {items: T[]; next: string | null} = await providerFetch(account, next)
        items.push(...page.items)
        next = page.next
    }
    return items
}

// Convert Spotify track payloads into the shared track representation.
function mapTrack(track: SpotifyTrack, itemId = track.uri): ProviderTrack {
    return {
        itemId,
        trackId: track.uri,
        title: track.name,
        artists: track.artists.map((artist) => artist.name),
        album: track.album?.name,
        durationMs: track.duration_ms,
        isrc: track.external_ids?.isrc,
        imageUrl: track.album?.images?.[0]?.url
    }
}

// Spotify adapter with batched playlist mutations and stable item positions.
export const spotifyAdapter: ProviderAdapter = {
    provider: "spotify",
    // Followed playlists stay in the source list. Pass writableOnly when the caller will write to the playlist.
    async listPlaylists(account, options) {
        const playlists = await collectPages<{
            id: string
            name?: string
            description?: string | null
            images?: {url: string}[]
            tracks?: {total?: number}
            items?: {total?: number}
            owner?: {id?: string}
            collaborative?: boolean
        }>(account, `${apiBase}/me/playlists?limit=50`)
        const me = options?.writableOnly ? await providerFetch<{id: string}>(account, `${apiBase}/me`) : undefined
        const visible = me ? playlists.filter((playlist) => playlist.collaborative || (Boolean(me.id) && playlist.owner?.id === me.id)) : playlists
        return visible.map((playlist): ProviderPlaylist => ({
            id: playlist.id,
            name: playlist.name || `Untitled playlist (${playlist.id})`,
            description: playlist.description ?? "",
            imageUrl: playlist.images?.[0]?.url,
            itemCount: playlist.tracks?.total ?? playlist.items?.total ?? 0
        }))
    },
    async createPlaylist(account, name, description) {
        const playlist = await providerFetch<{
            id: string
            name: string
            description?: string
            images?: {url: string}[]
        }>(account, `${apiBase}/me/playlists`, {
            method: "POST",
            // Spotify creates public playlists unless told otherwise, which would publish a private source playlist.
            body: JSON.stringify({name, public: false, description: createDescription(description)})
        })
        return {
            id: playlist.id,
            name: playlist.name,
            description: playlist.description ?? "",
            imageUrl: playlist.images?.[0]?.url,
            itemCount: 0
        }
    },
    async deletePlaylist(account, playlistId) {
        await providerFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/followers`, {
            method: "DELETE"
        })
    },
    async getPlaylistItems(account, playlistId) {
        const items = await collectPages<{item: SpotifyTrack | null}>(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/items?limit=50`)
        return items.flatMap((entry, index) => (entry.item ? [mapTrack(entry.item, `${entry.item.uri}:${index}`)] : []))
    },
    async searchTrackCandidates(account, track) {
        const query = track.isrc ? `isrc:${track.isrc}` : [`track:${searchableTitle(track.title)}`, track.artists[0] ? `artist:${track.artists[0]}` : ""].filter(Boolean).join(" ")
        const result = await providerFetch<{tracks: {items: SpotifyTrack[]}}>(account, `${apiBase}/search?type=track&limit=10&q=${encodeURIComponent(query)}`)
        return result.tracks.items.map((candidate) => mapTrack(candidate))
    },
    // Another release of a recording can carry a different ISRC, so a failed ISRC search retries by title and artist.
    async searchTrack(account, track) {
        const match = findBestTrackMatch(track, await this.searchTrackCandidates(account, track))
        return match || !track.isrc ? match : findBestTrackMatch(track, await this.searchTrackCandidates(account, {...track, isrc: undefined}))
    },
    async getTrackDurations(account, trackIds) {
        const durations = new Map<string, number>()
        const ids = trackIdsForProvider("spotify", trackIds).map((id) => (id.startsWith("spotify:track:") ? id.slice("spotify:track:".length) : id))
        if (!ids.length) {
            return durations
        }
        for (let index = 0; index < ids.length; index += 50) {
            const batch = ids.slice(index, index + 50)
            const result = await providerFetch<{tracks: (SpotifyTrack | null)[]}>(account, `${apiBase}/tracks?ids=${encodeURIComponent(batch.join(","))}`)
            for (const track of result.tracks) {
                if (track?.duration_ms) {
                    durations.set(track.uri, track.duration_ms)
                    durations.set(track.id, track.duration_ms)
                }
            }
        }
        return durations
    },
    async addTracks(account, playlistId, trackIds, onAdded) {
        for (let index = 0; index < trackIds.length; index += 100) {
            const batch = trackIds.slice(index, index + 100)
            await providerFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/items`, {
                method: "POST",
                body: JSON.stringify({uris: batch})
            })
            await onAdded?.(batch.map((providerTrackId) => ({providerTrackId})))
        }
    },
    async removePlaylistItems(account, playlistId, itemIds, onRemoved) {
        const remaining = new Map<string, number>()
        for (const itemId of itemIds) {
            const separator = itemId.lastIndexOf(":")
            const uri = separator > 0 ? itemId.slice(0, separator) : ""
            if (uri) {
                remaining.set(uri, (remaining.get(uri) || 0) + 1)
            }
        }
        // Resolve positions and the snapshot afresh for every batch: each deletion changes the
        // playlist snapshot and shifts the remaining positions, so results from an earlier
        // listing go stale as soon as the first batch succeeds.
        while ([...remaining.values()].some((count) => count > 0)) {
            const items = await collectPages<{item: SpotifyTrack | null}>(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/items?limit=50`)
            const playlist = await providerFetch<{snapshot_id?: string}>(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}?fields=snapshot_id`)
            const positionsByUri = new Map<string, number[]>()
            items.forEach((entry, position) => {
                const uri = entry.item?.uri
                if (uri) {
                    positionsByUri.set(uri, [...(positionsByUri.get(uri) || []), position])
                }
            })
            const batch: {uri: string; positions: number[]}[] = []
            for (const [uri, count] of remaining) {
                if (batch.length >= 100) {
                    break
                }
                if (count <= 0) {
                    continue
                }
                const positions = (positionsByUri.get(uri) || []).slice(0, count)
                if (!positions.length) {
                    remaining.set(uri, 0)
                    continue
                }
                batch.push({uri, positions})
            }
            if (!batch.length) {
                break
            }
            await providerFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/items`, {
                method: "DELETE",
                body: JSON.stringify({items: batch.map((group) => ({uri: group.uri, positions: group.positions})), ...(playlist.snapshot_id ? {snapshot_id: playlist.snapshot_id} : {})})
            })
            for (const group of batch) {
                remaining.set(group.uri, remaining.get(group.uri)! - group.positions.length)
            }
            await onRemoved?.(batch.flatMap((group) => group.positions.map((position) => `${group.uri}:${position}`)))
        }
    }
}
