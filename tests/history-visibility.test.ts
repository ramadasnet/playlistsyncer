import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {canViewRunHistory, runHistoryLimitFor, selectVisibleRuns, serializeSyncRun, serializeSyncTask, unmatchedTracksFromSnapshot, withTrackDurations} from "../server/domain/sync/history-visibility"
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

    test("keeps a deleted-source restore visible when a free account's latest run failed for another reason", () => {
        const deleted = {status: "failed" as const, failureReason: "deleted-source" as const}
        const later = {status: "failed" as const}
        const succeeded = {status: "succeeded" as const}
        expect(selectVisibleRuns([later, deleted], "free")).toEqual([later, deleted])
        expect(selectVisibleRuns([deleted], "free")).toEqual([deleted])
        expect(selectVisibleRuns([succeeded, deleted], "free")).toEqual([succeeded])
        expect(selectVisibleRuns([later, deleted], "pro")).toEqual([later, deleted])
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
            addedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "sp-1", title: " Added Song ", artists: [" Ada ", ""], playlistName: "Bike Deluxe", durationMs: 201_000}],
            removedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "sp-2", title: "Old Song", artists: ["Bea"], durationMs: 184_000}],
            unmatchedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "yt-9", title: "Missing Song", artists: ["Cara"], playlistName: "Bike Deluxe", durationMs: 210_000}],
            startedAt: now,
            finishedAt: now
        }

        expect(serializeSyncRun(run)).toMatchObject({
            id: run._id!.toHexString(),
            trigger: "manual",
            status: "partial",
            skipped: 2,
            addedTracks: [{title: "Added Song", artists: ["Ada"], playlistName: "Bike Deluxe", playlistId: "dst", providerTrackId: "sp-1", durationMs: 201_000}],
            removedTracks: [{title: "Old Song", artists: ["Bea"], playlistId: "dst", providerTrackId: "sp-2", durationMs: 184_000}],
            unmatchedTracks: [{title: "Missing Song", artists: ["Cara"], playlistName: "Bike Deluxe", playlistId: "dst", providerTrackId: "yt-9", durationMs: 210_000}]
        })
    })

    test("passes playlist issues through and omits them when empty", () => {
        const issue = {sourcePlaylistId: "src", destinationPlaylistId: "dst", name: "Road Trip", error: "unavailable"}
        const withIssues: SyncRunDocument = {
            _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0b1"),
            taskId: task._id!,
            trigger: "scheduled",
            status: "partial",
            additions: 0,
            removals: 0,
            conflicts: 0,
            skipped: 0,
            addedTracks: [],
            removedTracks: [],
            unmatchedTracks: [],
            failedPlaylists: [issue],
            missingSourcePlaylists: [{sourcePlaylistId: "gone", destinationPlaylistId: "kept", name: "Old mix"}],
            startedAt: now
        }
        const empty: SyncRunDocument = {...withIssues, _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0b2"), failedPlaylists: [], missingSourcePlaylists: []}

        expect(serializeSyncRun(withIssues).failedPlaylists).toEqual([issue])
        expect(serializeSyncRun(withIssues).missingSourcePlaylists).toEqual([{sourcePlaylistId: "gone", destinationPlaylistId: "kept", name: "Old mix"}])
        expect(serializeSyncRun(empty).failedPlaylists).toBeUndefined()
        expect(serializeSyncRun(empty).missingSourcePlaylists).toBeUndefined()
    })

    test("fills missing run-track lengths from the snapshot", () => {
        const accountId = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a4")
        const run: SyncRunDocument = {
            _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a6"),
            taskId: task._id!,
            trigger: "scheduled",
            status: "partial",
            additions: 1,
            removals: 0,
            conflicts: 0,
            skipped: 0,
            addedTracks: [{providerAccountId: accountId, playlistId: "dst", providerTrackId: "sp-1", title: "Added Song", artists: ["Ada"]}],
            removedTracks: [],
            unmatchedTracks: [],
            startedAt: now
        }

        expect(
            serializeSyncRun(run, task, [
                {
                    sourceItems: [],
                    destinationItems: [
                        {
                            occurrenceId: "dst-1",
                            canonicalKey: "canonical:added",
                            title: "Added Song",
                            artists: ["Ada"],
                            durationMs: 201_000,
                            providerItemId: "dst-1",
                            providerTrackId: "sp-1"
                        }
                    ],
                    createdAt: now
                }
            ]).addedTracks
        ).toEqual([{title: "Added Song", artists: ["Ada"], playlistId: "dst", providerTrackId: "sp-1", providerAccountId: accountId.toHexString(), durationMs: 201_000}])
    })

    test("identifies unmatched tracks from the playlist snapshot", () => {
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

        expect(unmatchedTracksFromSnapshot({sourceItems: [sourceOnly], destinationItems: [destOnly]}, {...task, direction: "one-way"}).map((track) => track.title)).toEqual(["Master Track"])
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

        expect(unmatchedTracksFromSnapshot({sourceItems: [sourceOnly], destinationItems: [destOnly]}, task).map((track) => track.title)).toEqual(["YouTube Only", "Spotify Only"])
    })

    test("copies catalog durations onto unmatched tracks that were stored without length", () => {
        const accountId = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a4")
        const unmatched = {providerAccountId: accountId, playlistId: "src", providerTrackId: "yt-2", title: "Midnight Radio", artists: ["Velvet Hours"]}

        expect(withTrackDurations([unmatched], new Map([["yt-2", 210_000]]))).toEqual([{...unmatched, durationMs: 210_000}])
        expect(withTrackDurations([{...unmatched, durationMs: 180_000}], new Map([["yt-2", 210_000]]))).toEqual([{...unmatched, durationMs: 180_000}])
    })
})
