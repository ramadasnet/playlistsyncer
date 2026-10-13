// Identify provider catalog IDs so duration lookups do not mix services.
import type {Provider} from "~~/shared/types/domain"

const spotifyTrackId = /^(?:spotify:track:)?[A-Za-z0-9]{22}$/
const youtubeVideoId = /^[A-Za-z0-9_-]{11}$/
const tidalTrackId = /^\d+$/
const soundCloudTrackId = /^soundcloud:tracks:\d+$/

// True when a stored identifier belongs to this provider's catalog.
export function isProviderTrackId(provider: Provider, trackId: string): boolean {
    if (!trackId) return false
    if (provider === "spotify") return spotifyTrackId.test(trackId)
    if (provider === "youtube") return youtubeVideoId.test(trackId)
    if (provider === "tidal") return tidalTrackId.test(trackId)
    if (provider === "soundcloud") return soundCloudTrackId.test(trackId)
    return false
}

// Keep only catalog IDs that the given provider can resolve.
export function trackIdsForProvider(provider: Provider, trackIds: string[]): string[] {
    return [...new Set(trackIds.filter((trackId) => isProviderTrackId(provider, trackId)))]
}

// Public page where a user can listen to a catalog track.
export function providerTrackUrl(provider: Provider, track: {trackId: string; url?: string}): string | undefined {
    if (track.url) return track.url
    if (!isProviderTrackId(provider, track.trackId)) return undefined
    if (provider === "spotify") return `https://open.spotify.com/track/${track.trackId.replace("spotify:track:", "")}`
    if (provider === "youtube") return `https://music.youtube.com/watch?v=${track.trackId}`
    if (provider === "tidal") return `https://tidal.com/browse/track/${track.trackId}`
    return undefined
}
