// Provider adapter that runs each request in the user's browser through the PlaylistSyncer extension.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {extensionWriteBatchSize, isExtensionProvider, type ExtensionCommandMap, type ExtensionCommandMethod, type ExtensionTrack} from "~~/shared/types/extension"
import {sendExtensionCommand} from "../extension/bridge"
import {findBestTrackMatch} from "./matching"
import type {ProviderAdapter, ProviderTrack} from "./types"

// Send one command for the account to the user's extension.
function send<M extends ExtensionCommandMethod>(account: ProviderAccountDocument, method: M, args: ExtensionCommandMap[M]["args"]) {
    if (!isExtensionProvider(account.provider) || !account.extensionAccountId) {
        throw createError({statusCode: 409, statusMessage: "This account is not connected through the browser extension"})
    }
    return sendExtensionCommand(account.userId.toHexString(), account.provider, account.extensionAccountId, method, args)
}

// Keep only the track fields that the extension needs.
function toExtensionTrack(track: ProviderTrack): ExtensionTrack {
    const {canonicalKey: _canonicalKey, ...rest} = track
    return rest
}

// Split a list into chunks that one command may carry.
function chunks<T>(values: T[]) {
    const result: T[][] = []
    for (let index = 0; index < values.length; index += extensionWriteBatchSize) {
        result.push(values.slice(index, index + extensionWriteBatchSize))
    }
    return result
}

// Build the adapter for one extension provider.
export function extensionAdapter(provider: ProviderAccountDocument["provider"]): ProviderAdapter {
    return {
        provider,
        listPlaylists: (account, options) => send(account, "listPlaylists", {writableOnly: options?.writableOnly}),
        createPlaylist: (account, name, description) => send(account, "createPlaylist", {name, description}),
        async deletePlaylist(account, playlistId) {
            await send(account, "deletePlaylist", {playlistId})
        },
        getPlaylistItems: (account, playlistId) => send(account, "getPlaylistItems", {playlistId}),
        searchTrackCandidates: (account, track) => send(account, "searchTrackCandidates", {track: toExtensionTrack(track)}),
        // Another release of a recording can carry a different ISRC, so a failed ISRC search retries by title and artist.
        async searchTrack(account, track) {
            const match = findBestTrackMatch(track, await this.searchTrackCandidates(account, track))
            return match || !track.isrc ? match : findBestTrackMatch(track, await this.searchTrackCandidates(account, {...track, isrc: undefined}))
        },
        async getTrackDurations(account, trackIds) {
            const durations = new Map<string, number>()
            for (const batch of chunks(trackIds)) {
                for (const [trackId, durationMs] of Object.entries(await send(account, "getTrackDurations", {trackIds: batch}))) {
                    if (Number.isFinite(durationMs)) {
                        durations.set(trackId, durationMs)
                    }
                }
            }
            return durations
        },
        async addTracks(account, playlistId, trackIds, onAdded) {
            for (const batch of chunks(trackIds)) {
                const added = await send(account, "addTracks", {playlistId, trackIds: batch})
                await onAdded?.(added?.length ? added : batch.map((providerTrackId) => ({providerTrackId})))
            }
        },
        async removePlaylistItems(account, playlistId, itemIds, onRemoved) {
            for (const batch of chunks(itemIds)) {
                await send(account, "removePlaylistItems", {playlistId, itemIds: batch})
                await onRemoved?.(batch)
            }
        }
    }
}
