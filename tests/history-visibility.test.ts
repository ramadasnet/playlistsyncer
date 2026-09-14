import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {canViewRunHistory, runHistoryLimitFor, serializeSyncRun, serializeSyncTask, unmatchedTracksFromSnapshot} from "../server/domain/sync/history-visibility"
import type {CanonicalTrack, SyncRunDocument, SyncTaskDocument} from "../shared/types/domain"

const now = new Date("2026-09-11T12:00:00.000Z")
const task: SyncTaskDocument = {
    _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a0"),
    userId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a1"),
    mode: "playlist",
    direction: "two-way",
    source: {providerAccountId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a2"), playlistId: "src", name: "Source"},
    destination: {providerAccountId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a3"), playlistId: "dst", name: "Destination"},
    status: "needs_attention",
    nextRunAt: now,
    lastRunAt: now,
    lastSuccessAt: now,
    lastError: "Needs a human ear",
    createdAt: now,
    updatedAt: now
}
const latestRun = {
    status: "partial" as const,
    additions: 3,
    removals: 1,
    conflicts: 2,
    skipped: 5,
    startedAt: now
}

describe("run history visibility", () => {
    test("is a PRO entitlement", () => {
        expect(canViewRunHistory("pro")).toBe(true)
        expect(canViewRunHistory("free")).toBe(false)
        expect(runHistoryLimitFor("pro")).toBe(50)
        expect(runHistoryLimitFor("free")).toBe(1)
    })

    test("includes latest-run counts for every account", () => {
        expect(serializeSyncTask(task, latestRun, "pro").latestRun).toEqual(latestRun)
        expect(serializeSyncTask(task, latestRun, "free").latestRun).toEqual(latestRun)
        expect(serializeSyncTask({...task, pauseReason: "entitlement"}, latestRun, "free", true)).toMatchObject({
            pauseReason: "entitlement",
            entitlementLocked: true,
            latestRun
        })
    })

    test("still exposes last-run timestamps to Free accounts", () => {
        const summary = serializeSyncTask(task, latestRun, "free")

        expect(summary.lastSuccessAt).toEqual(now)
        expect(summary.lastError).toBe("Needs a human ear")
        expect(summary.status).toBe("needs_attention")
    })

    test("serializes added, removed, and unmatched tracks from a run", () => {
        const accountId = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a4")
        const run: SyncRunDocument = {
            _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a5"),
            taskId: task._id!,
            trigger: "manual",
            status: "partial",
            additions: 1,
            removals: 1,
            conflicts: 0,
            skipped: 2,
            addedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "sp-1", title: " Added Song ", artists: [" Ada ", ""], playlistName: "Bike Deluxe"}],
            removedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "sp-2", title: "Old Song", artists: ["Bea"]}],
            unmatchedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "yt-9", title: "Missing Song", artists: ["Cara"], playlistName: "Bike Deluxe"}],
            startedAt: now,
            finishedAt: now
        }

        expect(serializeSyncRun(run)).toMatchObject({
            id: run._id!.toHexString(),
            trigger: "manual",
            status: "partial",
            skipped: 2,
            addedTracks: [{title: "Added Song", artists: ["Ada"], playlistName: "Bike Deluxe"}],
            removedTracks: [{title: "Old Song", artists: ["Bea"]}],
            unmatchedTracks: [{title: "Missing Song", artists: ["Cara"], playlistName: "Bike Deluxe"}]
        })
    })

    test("treats missing unmatched track lists as empty", () => {
        const run: SyncRunDocument = {
            _id: new ObjectId(),
            taskId: task._id!,
            trigger: "scheduled",
            status: "succeeded",
            additions: 0,
            removals: 0,
            conflicts: 0,
            skipped: 5,
            addedTracks: [],
            removedTracks: [],
            startedAt: now
        }

        expect(serializeSyncRun(run).unmatchedTracks).toEqual([])
        expect(serializeSyncRun(run).skipped).toBe(5)
    })

    test("recovers unmatched titles from the post-run snapshot", () => {
        const matched: CanonicalTrack = {
            occurrenceId: "src-1",
            canonicalKey: "canonical:matched",
            title: "Shared Song",
            artists: ["Ada"],
            providerItemId: "src-1",
            providerTrackId: "yt-1"
        }
        const unmatched: CanonicalTrack = {
            occurrenceId: "src-2",
            canonicalKey: "canonical:missing",
            title: "Midnight Radio",
            artists: ["Velvet Hours"],
            providerItemId: "src-2",
            providerTrackId: "yt-2"
        }

        expect(
            unmatchedTracksFromSnapshot(
                {
                    sourceItems: [matched, unmatched],
                    destinationItems: [{...matched, occurrenceId: "dst-1", providerItemId: "dst-1", providerTrackId: "sp-1"}]
                },
                task
            )
        ).toEqual([
            {
                providerAccountId: task.source.providerAccountId,
                playlistId: "src",
                providerTrackId: "yt-2",
                providerItemId: "src-2",
                title: "Midnight Radio",
                artists: ["Velvet Hours"],
                playlistName: "Source"
            }
        ])
    })

    test("does not treat leftover destination tracks as unmatched on one-way syncs", () => {
        const sourceOnly: CanonicalTrack = {
            occurrenceId: "src-1",
            canonicalKey: "canonical:source",
            title: "Master Track",
            artists: ["Ada"],
            providerItemId: "src-1",
            providerTrackId: "yt-1"
        }
        const destOnly: CanonicalTrack = {
            occurrenceId: "dst-1",
            canonicalKey: "canonical:dest",
            title: "Mirror Extra",
            artists: ["Bea"],
            providerItemId: "dst-1",
            providerTrackId: "sp-1"
        }

        expect(
            unmatchedTracksFromSnapshot(
                {sourceItems: [sourceOnly], destinationItems: [destOnly]},
                {...task, direction: "one-way"}
            ).map((track) => track.title)
        ).toEqual(["Master Track"])
    })

    test("includes unmatched tracks from either side on two-way syncs", () => {
        const sourceOnly: CanonicalTrack = {
            occurrenceId: "src-1",
            canonicalKey: "canonical:source",
            title: "YouTube Only",
            artists: ["Ada"],
            providerItemId: "src-1",
            providerTrackId: "yt-1"
        }
        const destOnly: CanonicalTrack = {
            occurrenceId: "dst-1",
            canonicalKey: "canonical:dest",
            title: "Spotify Only",
            artists: ["Bea"],
            providerItemId: "dst-1",
            providerTrackId: "sp-1"
        }

        expect(
            unmatchedTracksFromSnapshot({sourceItems: [sourceOnly], destinationItems: [destOnly]}, task).map((track) => track.title)
        ).toEqual(["YouTube Only", "Spotify Only"])
    })
})
