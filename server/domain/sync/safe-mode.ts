// Dry-run playlist mutations when PLS_SAFE_MODE is enabled.

export const safeModeWriteBlockedMessage = "PLS_SAFE_MODE is enabled; music providers will not be written"

import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"

export interface SafeModeTrack {
    title?: string
    artists?: string[]
}

// Read the process-wide flag that blocks all writes to music providers.
export function isSafeModeEnabled(): boolean {
    return getServerConfig().safeMode
}

// Format a track as "Title — Artist" for safe-mode logs.
export function formatSafeModeTrack(track: SafeModeTrack): string {
    const title = track.title?.trim() || "Unknown track"
    const artists = (track.artists || []).map((artist) => artist.trim()).filter(Boolean)
    return artists.length ? `${title} — ${artists.join(", ")}` : title
}

// Rebuild the playlist that would exist after applying planned membership changes.
export function playlistAfterChanges<T extends {itemId: string}>(current: T[], removalItemIds: string[], additions: T[]): T[] {
    const removed = new Set(removalItemIds)
    return [...current.filter((track) => !removed.has(track.itemId)), ...additions]
}

// Join planned playlist membership into a single log-friendly summary.
export function formatSafeModeFinalPlaylist(tracks: SafeModeTrack[]): string {
    return tracks.map(formatSafeModeTrack).join(" | ") || "(empty)"
}

// Log a playlist that would be created instead of calling the provider.
export function logSafeModeCreatePlaylist(provider: string, name: string) {
    logger.info("Sync.safeMode", provider, `Would create playlist ${name}`)
}

// Log a playlist that would be deleted instead of calling the provider.
export function logSafeModeDeletePlaylist(provider: string, playlistId: string, playlistName: string, tracks: SafeModeTrack[]) {
    logger.info("Sync.safeMode", provider, `Playlist ${playlistId}`, `Would delete playlist ${playlistName}`)
    for (const track of tracks) {
        logger.info("Sync.safeMode", provider, `Playlist ${playlistId}`, "Would remove", formatSafeModeTrack(track))
    }
    logger.info("Sync.safeMode", provider, `Playlist ${playlistId}`, "Final playlist (deleted)")
}

// Log every membership change that would be written, then the resulting playlist.
export function logSafeModePlaylistUpdate(input: {provider: string; playlistId: string; playlistName: string; removals: SafeModeTrack[]; additions: SafeModeTrack[]; unmatched: SafeModeTrack[]; finalTracks: SafeModeTrack[]}) {
    logger.info("Sync.safeMode", input.provider, `Playlist ${input.playlistId}`, input.playlistName, "Skipping playlist writes")
    for (const track of input.removals) {
        logger.info("Sync.safeMode", input.provider, `Playlist ${input.playlistId}`, "Would remove", formatSafeModeTrack(track))
    }
    for (const track of input.additions) {
        logger.info("Sync.safeMode", input.provider, `Playlist ${input.playlistId}`, "Would add", formatSafeModeTrack(track))
    }
    for (const track of input.unmatched) {
        logger.info("Sync.safeMode", input.provider, `Playlist ${input.playlistId}`, "Would skip unmatched", formatSafeModeTrack(track))
    }
    logger.info("Sync.safeMode", input.provider, `Playlist ${input.playlistId}`, `Final playlist (${input.finalTracks.length} tracks)`, formatSafeModeFinalPlaylist(input.finalTracks))
}
