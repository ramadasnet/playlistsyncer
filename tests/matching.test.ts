import {describe, expect, test} from "bun:test"
import {durationSimilarity, findBestTrackMatch, parseIsoDurationMs, rankSimilarTracks, youtubeMetadata} from "../server/domain/providers/matching"
import type {ProviderTrack} from "../server/domain/providers"

function track(title: string, artists: string[], isrc?: string): ProviderTrack {
    return {itemId: title, trackId: title, title, artists, isrc}
}

describe("provider track matching", () => {
    test("uses a cleaned YouTube topic channel as the artist", () => {
        expect(youtubeMetadata("Free Bird", "Lynyrd Skynyrd - Topic")).toEqual({
            title: "Free Bird",
            artists: ["Lynyrd Skynyrd"]
        })
    })

    test("prefers matching title and artist over provider rank", () => {
        const source = track("Free Bird", ["Lynyrd Skynyrd"])
        const wrong = track("Free Flow", ["BIRRD"])
        const correct = track("Free Bird - Audio", ["Lynyrd Skynyrd"])

        expect(findBestTrackMatch(source, [wrong, correct])).toBe(correct)
    })

    test("rejects the right title by a different artist", () => {
        const source = track("I Can See Clearly Now", ["Jimmy Cliff"])
        const wrong = track("I Can See Clearly Now", ["Various Artists"])

        expect(findBestTrackMatch(source, [wrong])).toBeNull()
    })

    test("rejects a live recording for a studio source", () => {
        const source = track("Could You Be Loved", ["Bob Marley"])
        const live = track("Could You Be Loved - Live", ["Bob Marley"])

        expect(findBestTrackMatch(source, [live])).toBeNull()
    })

    test("accepts an artist credit that includes a backing band", () => {
        const source = track("Could You Be Loved", ["Bob Marley"])
        const candidate = track("Could You Be Loved", ["Bob Marley & The Wailers"])

        expect(findBestTrackMatch(source, [candidate])).toBe(candidate)
    })

    test("accepts presentation and remaster title labels", () => {
        const source = track("The Sign (Remastered)", ["Ace of Base"])
        const candidate = track("The Sign", ["Ace of Base"])

        expect(findBestTrackMatch(source, [candidate])).toBe(candidate)
    })

    test("accepts an exact ISRC match", () => {
        const source = track("Different metadata", [], "USRC17607839")
        const correct = track("Hotel California", ["Eagles"], "USRC17607839")

        expect(findBestTrackMatch(source, [correct])).toBe(correct)
    })

    test("ranks looser similar tracks using title, artist, and length", () => {
        const source: ProviderTrack = {itemId: "src", trackId: "src", title: "Midnight Radio", artists: ["Velvet Hours"], durationMs: 210_000}
        const closer: ProviderTrack = {itemId: "a", trackId: "a", title: "Midnight Radio", artists: ["Velvet Hours"], durationMs: 212_000}
        const farther: ProviderTrack = {itemId: "b", trackId: "b", title: "Midnight Radio", artists: ["Velvet Hours"], durationMs: 180_000}
        const live: ProviderTrack = {itemId: "c", trackId: "c", title: "Midnight Radio (Live)", artists: ["Velvet Hours"], durationMs: 211_000}
        const unrelated: ProviderTrack = {itemId: "d", trackId: "d", title: "Ocean Walk", artists: ["Other Band"], durationMs: 210_000}

        expect(rankSimilarTracks(source, [unrelated, farther, live, closer]).map((item) => item.track)).toEqual([closer, farther, live])
        expect(durationSimilarity(210_000, 212_000)).toBeGreaterThan(durationSimilarity(210_000, 180_000))
        expect(parseIsoDurationMs("PT3M30S")).toBe(210_000)
    })
})
