// Adapt YouTube playlist operations to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {isUnavailableSyncTrack} from "~~/shared/unavailable-tracks"
import {providerFetch} from "./http"
import {findBestTrackMatch, parseIsoDurationMs, searchableTitle, youtubeMetadata} from "./matching"
import {trackIdsForProvider} from "./track-ids"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiBase = "https://www.googleapis.com/youtube/v3"

// Follow YouTube continuation tokens until all pages are collected.
async function collectPages<T>(account: ProviderAccountDocument, url: URL): Promise<T[]> {
    const items: T[] = []
    let pageToken: string | undefined
    do {
        if (pageToken) {
            url.searchParams.set("pageToken", pageToken)
        }
        const page: {items?: T[]; nextPageToken?: string} = await providerFetch(account, url.toString())
        items.push(...(page.items || []))
        pageToken = page.nextPageToken
    } while (pageToken)
    return items
}

// Look up ISO durations by video ID. Deleted and private videos are missing from the result.
async function lookupVideoDurations(account: ProviderAccountDocument, videoIds: string[]): Promise<Map<string, number | undefined>> {
    const durations = new Map<string, number | undefined>()
    const uniqueIds = [...new Set(trackIdsForProvider("youtube", videoIds))]
    for (let index = 0; index < uniqueIds.length; index += 50) {
        const batch = uniqueIds.slice(index, index + 50)
        const url = new URL(`${apiBase}/videos`)
        url.search = new URLSearchParams({part: "contentDetails", id: batch.join(","), maxResults: "50"}).toString()
        const result = await providerFetch<{items?: {id: string; contentDetails?: {duration?: string}}[]}>(account, url.toString())
        for (const item of result.items || []) {
            durations.set(item.id, parseIsoDurationMs(item.contentDetails?.duration) || undefined)
        }
    }
    return durations
}

// Load ISO durations for search candidates so similar-track ranking can use length.
async function videoDurationsMs(account: ProviderAccountDocument, videoIds: string[]): Promise<Map<string, number>> {
    const durations = new Map<string, number>()
    for (const [id, durationMs] of await lookupVideoDurations(account, videoIds)) {
        if (durationMs) {
            durations.set(id, durationMs)
        }
    }
    return durations
}

// YouTube adapter using playlist item identifiers for stable removals.
export const youtubeAdapter: ProviderAdapter = {
    provider: "youtube",
    async listPlaylists(account) {
        const url = new URL(`${apiBase}/playlists`)
        url.search = new URLSearchParams({part: "snippet,contentDetails", mine: "true", maxResults: "50"}).toString()
        const playlists = await collectPages<{
            id: string
            snippet?: {title?: string; description?: string; thumbnails?: {high?: {url: string}; default?: {url: string}}}
            contentDetails?: {itemCount?: number}
        }>(account, url)
        return playlists.map((playlist): ProviderPlaylist => ({
            id: playlist.id,
            name: playlist.snippet?.title || `Untitled playlist (${playlist.id})`,
            description: playlist.snippet?.description ?? "",
            imageUrl: playlist.snippet?.thumbnails?.high?.url || playlist.snippet?.thumbnails?.default?.url,
            itemCount: playlist.contentDetails?.itemCount ?? 0
        }))
    },
    async createPlaylist(account, name, description) {
        const playlist = await providerFetch<{id: string; snippet: {title: string; description?: string}}>(account, `${apiBase}/playlists?part=snippet,status`, {
            method: "POST",
            body: JSON.stringify({snippet: {title: name, description: description ?? ""}, status: {privacyStatus: "private"}})
        })
        return {
            id: playlist.id,
            name: playlist.snippet.title,
            description: playlist.snippet.description ?? "",
            itemCount: 0
        }
    },
    async deletePlaylist(account, playlistId) {
        await providerFetch(account, `${apiBase}/playlists?id=${encodeURIComponent(playlistId)}`, {method: "DELETE"})
    },
    async getPlaylistItems(account, playlistId) {
        const url = new URL(`${apiBase}/playlistItems`)
        url.search = new URLSearchParams({
            part: "snippet,contentDetails",
            playlistId,
            maxResults: "50"
        }).toString()
        const items = await collectPages<{
            id: string
            snippet: {title: string; videoOwnerChannelTitle?: string; thumbnails?: {high?: {url: string}}}
            contentDetails: {videoId: string}
        }>(account, url)
        const mapped = items.map((item): ProviderTrack => ({
            itemId: item.id,
            trackId: item.contentDetails.videoId,
            ...youtubeMetadata(item.snippet.title, item.snippet.videoOwnerChannelTitle),
            imageUrl: item.snippet.thumbnails?.high?.url
        }))
        const durations = await videoDurationsMs(
            account,
            mapped.map((track) => track.trackId)
        )
        return mapped.map((track) => ({...track, durationMs: durations.get(track.trackId)}))
    },
    getTrackDurations(account, trackIds) {
        return videoDurationsMs(account, trackIds)
    },
    async searchTrackCandidates(account, track) {
        const url = new URL(`${apiBase}/search`)
        url.search = new URLSearchParams({
            part: "snippet",
            type: "video",
            videoCategoryId: "10",
            maxResults: "10",
            q: `${track.artists.join(" ")} ${searchableTitle(track.title)}`
        }).toString()
        const result = await providerFetch<{
            items?: {
                id: {videoId: string}
                snippet: {title: string; channelTitle?: string; thumbnails?: {high?: {url: string}}}
            }[]
        }>(account, url.toString())
        const candidates = (result.items || [])
            .filter((candidate) => !isUnavailableSyncTrack({title: candidate.snippet.title}))
            .map((candidate): ProviderTrack => ({
                itemId: candidate.id.videoId,
                trackId: candidate.id.videoId,
                ...youtubeMetadata(candidate.snippet.title, candidate.snippet.channelTitle),
                imageUrl: candidate.snippet.thumbnails?.high?.url
            }))
        const durations = await lookupVideoDurations(
            account,
            candidates.map((candidate) => candidate.trackId)
        )
        // Search results can still list deleted or private videos that the videos endpoint no longer returns.
        return candidates.filter((candidate) => durations.has(candidate.trackId)).map((candidate) => ({...candidate, durationMs: durations.get(candidate.trackId)}))
    },
    async searchTrack(account, track) {
        return findBestTrackMatch(track, await this.searchTrackCandidates(account, track))
    },
    async addTracks(account, playlistId, trackIds, onAdded) {
        for (const videoId of trackIds) {
            const item = await providerFetch<{id: string}>(account, `${apiBase}/playlistItems?part=snippet`, {
                method: "POST",
                body: JSON.stringify({snippet: {playlistId, resourceId: {kind: "youtube#video", videoId}}})
            })
            await onAdded?.([{providerTrackId: videoId, providerItemId: item.id}])
        }
    },
    async removePlaylistItems(account, _playlistId, itemIds, onRemoved) {
        for (const itemId of itemIds) {
            await providerFetch(account, `${apiBase}/playlistItems?id=${encodeURIComponent(itemId)}`, {
                method: "DELETE"
            })
            await onRemoved?.([itemId])
        }
    }
}
