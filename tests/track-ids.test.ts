import {describe, expect, test} from "bun:test"
import {isProviderTrackId, trackIdsForProvider} from "../server/domain/providers/track-ids"

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
})
