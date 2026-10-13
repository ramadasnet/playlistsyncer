import {describe, expect, test} from "bun:test"
import {isProviderTrackId, providerTrackUrl, trackIdsForProvider} from "../server/domain/providers/track-ids"

describe("provider catalog identifiers", () => {
    test("keeps only Spotify IDs when resolving Spotify durations", () => {
        const ids = ["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "4uLU6hMCjMI75M1A2tKUQC", "dQw4w9WgXcQ", "123456789"]

        expect(trackIdsForProvider("spotify", ids)).toEqual(["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "4uLU6hMCjMI75M1A2tKUQC"])
        expect(isProviderTrackId("spotify", "dQw4w9WgXcQ")).toBe(false)
    })

    test("keeps only YouTube video IDs when resolving YouTube durations", () => {
        expect(trackIdsForProvider("youtube", ["dQw4w9WgXcQ", "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "123456789"])).toEqual(["dQw4w9WgXcQ"])
    })

    test("keeps only numeric TIDAL IDs", () => {
        expect(trackIdsForProvider("tidal", ["123456789", "dQw4w9WgXcQ", "spotify:track:4uLU6hMCjMI75M1A2tKUQC"])).toEqual(["123456789"])
    })

    test("keeps SoundCloud track URNs distinct from numeric TIDAL IDs", () => {
        expect(trackIdsForProvider("soundcloud", ["soundcloud:tracks:123456789", "123456789", "dQw4w9WgXcQ"])).toEqual(["soundcloud:tracks:123456789"])
        expect(isProviderTrackId("tidal", "soundcloud:tracks:123456789")).toBe(false)
        expect(isProviderTrackId("soundcloud", "123456789")).toBe(false)
    })

    test("builds public track pages for each provider", () => {
        expect(providerTrackUrl("spotify", {trackId: "spotify:track:4uLU6hMCjMI75M1A2tKUQC"})).toBe("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
        expect(providerTrackUrl("youtube", {trackId: "dQw4w9WgXcQ"})).toBe("https://music.youtube.com/watch?v=dQw4w9WgXcQ")
        expect(providerTrackUrl("tidal", {trackId: "123456789"})).toBe("https://tidal.com/browse/track/123456789")
        expect(providerTrackUrl("soundcloud", {trackId: "soundcloud:tracks:1", url: "https://soundcloud.com/artist/song"})).toBe("https://soundcloud.com/artist/song")
        expect(providerTrackUrl("soundcloud", {trackId: "soundcloud:tracks:1"})).toBeUndefined()
        expect(providerTrackUrl("tidal", {trackId: "../evil"})).toBeUndefined()
    })
})
