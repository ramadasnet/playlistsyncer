import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {canonicalItemsWithAliases, findSnapshotItem, manualMatchAliases, moveUnmatchedToAdded, resolveMatchTarget, unmatchedTrackMatches} from "../server/domain/sync/manual-match"
import {trackKey} from "../server/domain/sync/reconcile"
import type {CanonicalTrack, SyncTaskDocument} from "../shared/types/domain"

const sourceAccount = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a2")
const destinationAccount = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a3")
const task: Pick<SyncTaskDocument, "source" | "destination" | "playlistMappings"> = {
    source: {providerAccountId: sourceAccount, playlistId: "src", name: "Source"},
    destination: {providerAccountId: destinationAccount, playlistId: "dst", name: "Destination"}
}

function snapshotTrack(id: string, key: string, title = id): CanonicalTrack {
    return {
        occurrenceId: id,
        canonicalKey: key,
        title,
        artists: ["Ada"],
        providerItemId: id,
        providerTrackId: `track-${id}`
    }
}

describe("manual unmatched-track matching", () => {
    test("resolves the counterpart playlist for each unmatched side", () => {
        expect(resolveMatchTarget(task, "src")).toEqual({
            unmatchedSide: "source",
            targetSide: "destination",
            targetPlaylistId: "dst",
            targetPlaylistName: "Destination"
        })
        expect(resolveMatchTarget(task, "dst")).toEqual({
            unmatchedSide: "destination",
            targetSide: "source",
            targetPlaylistId: "src",
            targetPlaylistName: "Source"
        })
    })

    test("uses account playlist mappings when the pair is not the task roots", () => {
        expect(
            resolveMatchTarget(
                {
                    ...task,
                    playlistMappings: [{sourcePlaylistId: "yt-pl", destinationPlaylistId: "sp-pl", name: "Road trip"}]
                },
                "yt-pl"
            )
        ).toEqual({
            unmatchedSide: "source",
            targetSide: "destination",
            targetPlaylistId: "sp-pl",
            targetPlaylistName: "Road trip"
        })
    })

    test("matches unmatched identity by playlist and track, then item id when both exist", () => {
        const stored = {playlistId: "src", providerTrackId: "yt-2", providerItemId: "item-2"}
        expect(unmatchedTrackMatches(stored, {playlistId: "src", providerTrackId: "yt-2"})).toBe(true)
        expect(unmatchedTrackMatches(stored, {playlistId: "src", providerTrackId: "yt-2", providerItemId: "item-2"})).toBe(true)
        expect(unmatchedTrackMatches(stored, {playlistId: "src", providerTrackId: "yt-2", providerItemId: "other"})).toBe(false)
        expect(unmatchedTrackMatches(stored, {playlistId: "src", providerTrackId: "yt-9"})).toBe(false)
    })

    test("aliases the unmatched row and the chosen catalog track to one canonical key", () => {
        const unmatched = snapshotTrack("src-2", "canonical:missing", "Midnight Radio")
        const aliases = manualMatchAliases({sourceItems: [unmatched], destinationItems: []}, {providerItemId: "src-2", providerTrackId: "track-src-2"}, {providerItemId: "dst-9", providerTrackId: "spotify:track:abc"}, unmatched.canonicalKey)
        const linked = canonicalItemsWithAliases(
            [
                {itemId: "src-2", trackId: "track-src-2", title: "Midnight Radio", artists: ["Ada"]},
                {itemId: "dst-9", trackId: "spotify:track:abc", title: "Midnight Radio", artists: ["Ada"]}
            ],
            aliases
        )

        expect(findSnapshotItem([unmatched], {providerItemId: "src-2", providerTrackId: "track-src-2"})).toBe(unmatched)
        expect(linked.map((item) => item.canonicalKey)).toEqual(["canonical:missing", "canonical:missing"])
        expect(trackKey({title: "Other Song", artists: ["Bea"]})).not.toBe(unmatched.canonicalKey)
    })

    test("moves a matched track from unmatched to added and updates the counts", () => {
        const unmatched = {providerAccountId: sourceAccount, playlistId: "src", providerTrackId: "yt-2", providerItemId: "item-2", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const added = {providerAccountId: destinationAccount, playlistId: "dst", providerTrackId: "sp-9", providerItemId: "item-9", title: "Midnight Radio", artists: ["Velvet Hours"], playlistName: "Road Trip"}
        const next = moveUnmatchedToAdded(
            {status: "partial" as const, additions: 1, skipped: 2, conflicts: 0, addedTracks: [], unmatchedTracks: [unmatched, {providerAccountId: sourceAccount, playlistId: "src", providerTrackId: "yt-3", title: "Other", artists: ["Bea"]}]},
            {playlistId: "src", providerTrackId: "yt-2", providerItemId: "item-2"},
            added
        )

        expect(next).toMatchObject({
            additions: 2,
            skipped: 1,
            status: "partial",
            unmatchedTracks: [{providerTrackId: "yt-3"}],
            addedTracks: [added]
        })
    })

    test("moves only the requested playlist when the same song is unmatched twice", () => {
        const focus = {providerAccountId: sourceAccount, playlistId: "focus", providerTrackId: "yt-2", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const sleep = {providerAccountId: sourceAccount, playlistId: "sleep", providerTrackId: "yt-2", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const added = {providerAccountId: destinationAccount, playlistId: "focus-dest", providerTrackId: "sp-9", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const next = moveUnmatchedToAdded({status: "partial" as const, additions: 0, skipped: 2, conflicts: 0, addedTracks: [], unmatchedTracks: [focus, sleep]}, {playlistId: "focus", providerTrackId: "yt-2"}, added)

        expect(next).toMatchObject({
            additions: 1,
            skipped: 1,
            unmatchedTracks: [sleep],
            addedTracks: [added]
        })
    })

    test("does not replace track lists on a run that is still writing", () => {
        const unmatched = {providerAccountId: sourceAccount, playlistId: "src", providerTrackId: "yt-2", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const added = {providerAccountId: destinationAccount, playlistId: "dst", providerTrackId: "sp-9", title: "Midnight Radio", artists: ["Velvet Hours"]}
        const next = moveUnmatchedToAdded({status: "running" as const, additions: 4, skipped: 1, conflicts: 0, addedTracks: [], unmatchedTracks: [unmatched]}, {playlistId: "src", providerTrackId: "yt-2"}, added)

        expect(next).toBeNull()
    })
})
