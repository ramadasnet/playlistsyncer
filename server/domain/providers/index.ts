// Select the adapter that implements a configured music provider.
import type {Provider} from "~~/shared/types/domain"
import {spotifyAdapter} from "./spotify"
import {tidalAdapter} from "./tidal"
import type {ProviderAdapter} from "./types"
import {youtubeAdapter} from "./youtube"

// Resolve a provider adapter or report unsupported provider capabilities.
export function getProviderAdapter(provider: Provider): ProviderAdapter {
    if (provider === "spotify") {
        return spotifyAdapter
    }
    if (provider === "tidal") {
        return tidalAdapter
    }
    if (provider === "youtube") {
        return youtubeAdapter
    }
    throw createError({
        statusCode: 501,
        statusMessage: "Amazon Music playlist support requires the approved API contract to be configured"
    })
}

export type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"
