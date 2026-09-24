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
