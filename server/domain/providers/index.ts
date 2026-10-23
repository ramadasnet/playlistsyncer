// Select the adapter that implements a configured music provider.
import type {Provider, ProviderAccountDocument} from "~~/shared/types/domain"
import {isSafeModeEnabled, logSafeModeCreatePlaylist, logSafeModeDeletePlaylist, safeModeWriteBlockedMessage} from "../sync/safe-mode"
import logger from "../../utils/logger"
import {appleAdapter} from "./apple"
import {soundcloudAdapter} from "./soundcloud"
import {spotifyAdapter} from "./spotify"
import {tidalAdapter} from "./tidal"
import type {ProviderAdapter} from "./types"
import {youtubeAdapter} from "./youtube"

// Replace mutating adapter methods with logs so PLS_SAFE_MODE cannot write to music providers.
export function withoutProviderWrites(adapter: ProviderAdapter): ProviderAdapter {
    return {
        provider: adapter.provider,
        ...(adapter.appendOnly ? {appendOnly: true} : {}),
        listPlaylists: (account, options) => adapter.listPlaylists(account, options),
        getPlaylistItems: (account, playlistId) => adapter.getPlaylistItems(account, playlistId),
        searchTrack: (account, track) => adapter.searchTrack(account, track),
        searchTrackCandidates: (account, track) => adapter.searchTrackCandidates(account, track),
        getTrackDurations: (account, trackIds) => adapter.getTrackDurations(account, trackIds),
        async createPlaylist(account: ProviderAccountDocument, name: string, _description?: string) {
            logSafeModeCreatePlaylist(account.provider, name)
            throw new Error(safeModeWriteBlockedMessage)
        },
        async deletePlaylist(account: ProviderAccountDocument, playlistId: string) {
            logSafeModeDeletePlaylist(account.provider, playlistId, playlistId, [])
        },
        async addTracks(account: ProviderAccountDocument, playlistId: string, trackIds: string[]) {
            logger.info("Sync.safeMode", account.provider, `Playlist ${playlistId}`, `Blocked addTracks (${trackIds.length})`)
        },
        async removePlaylistItems(account: ProviderAccountDocument, playlistId: string, itemIds: string[]) {
            logger.info("Sync.safeMode", account.provider, `Playlist ${playlistId}`, `Blocked removePlaylistItems (${itemIds.length})`)
        }
    }
}

// Resolve a provider adapter or report unsupported provider capabilities.
export function getProviderAdapter(provider: Provider): ProviderAdapter {
    let adapter: ProviderAdapter
    if (provider === "spotify") {
        adapter = spotifyAdapter
    } else if (provider === "tidal") {
        adapter = tidalAdapter
    } else if (provider === "youtube") {
        adapter = youtubeAdapter
    } else if (provider === "soundcloud") {
        adapter = soundcloudAdapter
    } else if (provider === "apple") {
        adapter = appleAdapter
    } else {
        throw createError({
            statusCode: 501,
            statusMessage: "Amazon Music playlist support requires the approved API contract to be configured"
        })
    }
    return isSafeModeEnabled() ? withoutProviderWrites(adapter) : adapter
}

export type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"
