import {describe, expect, test} from "bun:test"
import {commonTracks, reconcileThreeWay, trackKey} from "../server/domain/sync/reconcile"
import type {ProviderTrack} from "../server/domain/providers"

function track(title: string, itemId = title): ProviderTrack {
    return {itemId, trackId: title, title, artists: ["Artist"], durationMs: 180_000}
}

describe("three-way playlist reconciliation", () => {
    test("propagates an addition made on either side", () => {
        const original = track("Original")
        const added = track("Added")
        const result = reconcileThreeWay([original], [original, added], [original])

        expect(result.desired.map((item) => item.key)).toContain(trackKey(added))
        expect(result.conflicts).toEqual([])
    })

    test("propagates a removal when the other side is unchanged", () => {
        const removed = track("Removed")
        expect(reconcileThreeWay([removed], [], [removed]).desired).toEqual([])
    })

    test("preserves data and reports contradictory changes", () => {
        const duplicate = track("Duplicate")
        const result = reconcileThreeWay([duplicate], [], [duplicate, track("Duplicate", "second")])

        expect(result.desired[0]?.count).toBe(2)
        expect(result.conflicts).toEqual([trackKey(duplicate)])
    })

    test("uses a persisted canonical alias across provider metadata", () => {
        const source = {...track("Song title"), canonicalKey: "canonical:song"}
        const destination = {...track("Artist - Song title (Official Video)"), canonicalKey: "canonical:song"}
        const result = reconcileThreeWay([source], [source], [destination])

        expect(result.desired).toHaveLength(1)
        expect(result.desired[0]?.count).toBe(1)
        expect(result.conflicts).toEqual([])
    })

    test("keeps unmatched source tracks outside the synchronized baseline", () => {
        const synchronized = {...track("Synchronized"), canonicalKey: "canonical:synchronized"}
        const unmatched = {...track("Unmatched"), canonicalKey: "canonical:unmatched"}
        const baseline = commonTracks([synchronized, unmatched], [synchronized])
        const result = reconcileThreeWay(baseline, [synchronized, unmatched], [synchronized])

        expect(baseline).toEqual([synchronized])
        expect(result.desired.map((item) => item.key)).toContain("canonical:unmatched")
    })
})
