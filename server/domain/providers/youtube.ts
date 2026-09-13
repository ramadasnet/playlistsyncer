// Adapt YouTube playlist operations to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {providerFetch} from "./http"
import {findBestTrackMatch, searchableTitle, youtubeMetadata} from "./matching"
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

// YouTube adapter using playlist item identifiers for stable removals.
export const youtubeAdapter: ProviderAdapter = {
    provider: "youtube",
    async listPlaylists(account) {
        const url = new URL(`${apiBase}/playlists`)
        url.search = new URLSearchParams({part: "snippet,contentDetails", mine: "true", maxResults: "50"}).toString()
        const playlists = await collectPages<{
            id: string
            snippet: {title: string; description?: string; thumbnails?: {high?: {url: string}; default?: {url: string}}}
            contentDetails: {itemCount: number}
        }>(account, url)
        return playlists.map((playlist): ProviderPlaylist => ({
            id: playlist.id,
            name: playlist.snippet.title,
            description: playlist.snippet.description,
            imageUrl: playlist.snippet.thumbnails?.high?.url || playlist.snippet.thumbnails?.default?.url,
            itemCount: playlist.contentDetails.itemCount
        }))
    },
    async createPlaylist(account, name) {
        const playlist = await providerFetch<{id: string; snippet: {title: string; description?: string}}>(account, `${apiBase}/playlists?part=snippet,status`, {
            method: "POST",
            body: JSON.stringify({snippet: {title: name}, status: {privacyStatus: "private"}})
        })
        return {
            id: playlist.id,
            name: playlist.snippet.title,
            description: playlist.snippet.description,
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
        return items.map((item): ProviderTrack => ({
            itemId: item.id,
            trackId: item.contentDetails.videoId,
            ...youtubeMetadata(item.snippet.title, item.snippet.videoOwnerChannelTitle),
            imageUrl: item.snippet.thumbnails?.high?.url
        }))
    },
    async searchTrack(account, track) {
        const url = new URL(`${apiBase}/search`)
        url.search = new URLSearchParams({
            part: "snippet",
            type: "video",
            videoCategoryId: "10",
            maxResults: "5",
            q: `${track.artists.join(" ")} ${searchableTitle(track.title)}`
        }).toString()
        const result = await providerFetch<{
            items?: {
                id: {videoId: string}
                snippet: {title: string; channelTitle?: string; thumbnails?: {high?: {url: string}}}
            }[]
        }>(account, url.toString())
        const candidates = (result.items || []).map((candidate): ProviderTrack => ({
            itemId: candidate.id.videoId,
            trackId: candidate.id.videoId,
            ...youtubeMetadata(candidate.snippet.title, candidate.snippet.channelTitle),
            imageUrl: candidate.snippet.thumbnails?.high?.url
        }))
        return findBestTrackMatch(track, candidates)
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
