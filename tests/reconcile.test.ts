import {describe, expect, test} from "bun:test"
import {commonTracks, reconcileOneWay, reconcileThreeWay, trackKey} from "../server/domain/sync/reconcile"
import type {ProviderTrack} from "../server/domain/providers"
import {accountSyncConflictMessage, accountSyncsBlockingAllPairs, allPairsBlockedMessage, findAccountSyncBetweenProviders, resolvedTaskDirection} from "../shared/types/domain"

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

describe("account sync provider pairs", () => {
    const tasks = [{mode: "account" as const, sourceProvider: "youtube" as const, destinationProvider: "spotify" as const}]

    test("matches an existing all-playlists sync in the same direction", () => {
        expect(findAccountSyncBetweenProviders(tasks, "youtube", "spotify")).toBe(tasks[0])
    })

    test("matches the reverse provider pair so the mirror cannot sync back to its master", () => {
        expect(findAccountSyncBetweenProviders(tasks, "spotify", "youtube")).toBe(tasks[0])
    })

    test("ignores unrelated provider pairs and playlist tasks", () => {
        expect(findAccountSyncBetweenProviders(tasks, "spotify", "tidal")).toBeUndefined()
        expect(findAccountSyncBetweenProviders([{mode: "playlist", sourceProvider: "youtube", destinationProvider: "spotify"}], "youtube", "spotify")).toBeUndefined()
    })

    test("names the existing sync direction in the conflict message", () => {
        expect(accountSyncConflictMessage(tasks[0]!)).toBe("There's already a full sync from YouTube Music to Spotify. Delete it if you want to create another sync task between these providers.")
    })

    test("blocks all new tasks when a full sync covers the only connected provider pair", () => {
        expect(accountSyncsBlockingAllPairs(tasks, ["spotify", "youtube"])).toEqual([tasks[0]!])
        expect(allPairsBlockedMessage(accountSyncsBlockingAllPairs(tasks, ["spotify", "youtube"]))).toBe(accountSyncConflictMessage(tasks[0]!))
    })

    test("keeps task creation open while another provider pair is available", () => {
        expect(accountSyncsBlockingAllPairs(tasks, ["spotify", "youtube", "tidal"])).toEqual([])
        expect(accountSyncsBlockingAllPairs([{mode: "playlist", sourceProvider: "youtube", destinationProvider: "spotify"}], ["spotify", "youtube"])).toEqual([])
    })

    test("blocks all new tasks when full syncs cover every connected provider pair", () => {
        const fullSyncs = [...tasks, {mode: "account" as const, sourceProvider: "spotify" as const, destinationProvider: "tidal" as const}, {mode: "account" as const, sourceProvider: "tidal" as const, destinationProvider: "youtube" as const}]

        expect(accountSyncsBlockingAllPairs(fullSyncs, ["spotify", "youtube", "tidal"])).toHaveLength(3)
        expect(allPairsBlockedMessage(fullSyncs)).toBe("All your connected providers are already covered by full syncs. Delete one of them if you want to create another sync task.")
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
