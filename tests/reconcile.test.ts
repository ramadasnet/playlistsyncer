import {describe, expect, test} from "bun:test"
import {commonTracks, reconcileOneWay, reconcileThreeWay, trackKey} from "../server/domain/sync/reconcile"
import type {ProviderTrack} from "../server/domain/providers"
import {resolvedTaskDirection} from "../shared/types/domain"

function track(title: string, itemId = title): ProviderTrack {
    return {itemId, trackId: title, title, artists: ["Artist"], durationMs: 180_000}
}

describe("one-way playlist mirroring", () => {
    test("uses the source playlist as the desired membership", () => {
        const kept = track("Kept")
        const added = track("Added")
        const result = reconcileOneWay([kept, added, track("Kept", "duplicate")])

        expect(result.conflicts).toEqual([])
        expect(result.desired.find((item) => item.key === trackKey(kept))?.count).toBe(2)
        expect(result.desired.map((item) => item.key)).toContain(trackKey(added))
    })

    test("omits tracks that exist only on the destination", () => {
        const master = track("Master")
        const result = reconcileOneWay([master])

        expect(result.desired).toHaveLength(1)
        expect(result.desired[0]?.key).toBe(trackKey(master))
    })
})

describe("task direction defaults", () => {
    test("treats missing playlist tasks as two-way", () => {
        expect(resolvedTaskDirection({})).toBe("two-way")
        expect(resolvedTaskDirection({mode: "playlist"})).toBe("two-way")
    })

    test("treats missing account tasks as one-way", () => {
        expect(resolvedTaskDirection({mode: "account"})).toBe("one-way")
    })

    test("preserves an explicit direction", () => {
        expect(resolvedTaskDirection({mode: "playlist", direction: "one-way"})).toBe("one-way")
        expect(resolvedTaskDirection({mode: "account", direction: "two-way"})).toBe("two-way")
    })
})

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
