import {describe, expect, test} from "bun:test"
import {enabledProviders, isProviderEnabled} from "../server/utils/provider-availability"
import {parseServerConfig} from "../server/utils/config"

const fullyConfigured = parseServerConfig({
    amazonClientId: "amazon-id",
    amazonClientSecret: "amazon-secret",
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    spotifyClientId: "spotify-id",
    spotifyClientSecret: "spotify-secret",
    tidalClientId: "tidal-id",
    tidalClientSecret: "tidal-secret"
})

describe("provider availability", () => {
    test("requires both OAuth client ID and secret", () => {
        expect(isProviderEnabled("spotify", parseServerConfig({spotifyClientId: "spotify-id"}))).toBe(false)
        expect(isProviderEnabled("spotify", parseServerConfig({spotifyClientSecret: "spotify-secret"}))).toBe(false)
        expect(isProviderEnabled("youtube", parseServerConfig({googleClientId: "google-id", googleClientSecret: "google-secret"}))).toBe(true)
    })

    test("keeps an explicitly disabled provider hidden even when credentials are set", () => {
        expect(isProviderEnabled("amazon", fullyConfigured)).toBe(false)
        expect(enabledProviders(fullyConfigured)).toEqual(["spotify", "tidal", "youtube"])
    })

    test("hides providers whose credentials are missing", () => {
        expect(
            enabledProviders(
                parseServerConfig({
                    spotifyClientId: "spotify-id",
                    spotifyClientSecret: "spotify-secret",
                    tidalClientId: "tidal-id",
                    tidalClientSecret: "tidal-secret"
                })
            )
        ).toEqual(["spotify", "tidal"])
    })
})
