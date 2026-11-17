import {describe, expect, test} from "bun:test"
import {enabledProviders, isProviderEnabled} from "../server/utils/provider-availability"
import {parseServerConfig} from "../server/utils/config"

const fullyConfigured = parseServerConfig({
    amazonClientId: "amazon-id",
    amazonClientSecret: "amazon-secret",
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    spotifyCredentials: "spotify-id:spotify-secret",
    soundcloudClientId: "soundcloud-id",
    soundcloudClientSecret: "soundcloud-secret",
    tidalClientId: "tidal-id",
    tidalClientSecret: "tidal-secret"
})

describe("provider availability", () => {
    test("ignores the removed standalone Spotify credentials", () => {
        const config = parseServerConfig({spotifyClientId: "legacy-id", spotifyClientSecret: "legacy-secret"})

        expect(config).not.toHaveProperty("spotifyClientId")
        expect(config).not.toHaveProperty("spotifyClientSecret")
        expect(isProviderEnabled("spotify", config)).toBe(false)
    })

    test("requires both OAuth client ID and secret", () => {
        expect(isProviderEnabled("spotify", parseServerConfig({}))).toBe(false)
        expect(isProviderEnabled("spotify", parseServerConfig({spotifyCredentials: "spotify-id:spotify-secret"}))).toBe(true)
        expect(isProviderEnabled("youtube", parseServerConfig({googleClientId: "google-id", googleClientSecret: "google-secret"}))).toBe(true)
        expect(isProviderEnabled("soundcloud", parseServerConfig({soundcloudClientId: "soundcloud-id"}))).toBe(false)
        expect(isProviderEnabled("soundcloud", parseServerConfig({soundcloudClientId: "soundcloud-id", soundcloudClientSecret: "soundcloud-secret"}))).toBe(true)
    })

    test("keeps an explicitly disabled provider hidden even when credentials are set", () => {
        expect(isProviderEnabled("amazon", fullyConfigured)).toBe(false)
        expect(enabledProviders(fullyConfigured)).toEqual(["spotify", "tidal", "youtube", "soundcloud"])
    })

    test("hides providers whose credentials are missing", () => {
        expect(
            enabledProviders(
                parseServerConfig({
                    spotifyCredentials: "spotify-id:spotify-secret",
                    tidalClientId: "tidal-id",
                    tidalClientSecret: "tidal-secret"
                })
            )
        ).toEqual(["spotify", "tidal"])
    })
})
