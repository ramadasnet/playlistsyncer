import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {AccountSnapshotPlaylist, SyncSnapshotDocument} from "../shared/types/domain"
import {accountSnapshotBatches, accountSnapshotPlaylistBatchSize, combinedSnapshot, snapshotDurationPipeline, snapshotForDurations, snapshotItemsForPlaylist, tracksMissingDuration} from "../server/domain/sync/snapshot-batches"

function playlist(index: number): AccountSnapshotPlaylist {
    return {
        sourcePlaylistId: `source-${index}`,
        destinationPlaylistId: `destination-${index}`,
        name: `Playlist ${index}`,
        sourceItems: [],
        destinationItems: []
    }
}

describe("full sync snapshot batches", () => {
    test("keeps each batch to 30 playlists", () => {
        expect(accountSnapshotBatches([])).toEqual([])
        expect(accountSnapshotBatches([playlist(0)])).toHaveLength(1)
        const batches = accountSnapshotBatches(Array.from({length: accountSnapshotPlaylistBatchSize + 1}, (_, index) => playlist(index)))
        expect(batches).toHaveLength(2)
        expect(batches[0]).toHaveLength(30)
        expect(batches[1]).toHaveLength(1)
    })

    test("combines playlist tasks and full-sync batches into one track list", () => {
        const taskId = new ObjectId()
        const snapshots: SyncSnapshotDocument[] = [
            {
                taskId,
                batch: 0,
                playlists: [{...playlist(0), sourceItems: [{occurrenceId: "a", canonicalKey: "meta:a:artist", title: "A", artists: ["Artist"], providerItemId: "a", providerTrackId: "track-a"}], destinationItems: []}],
                sourceItems: [],
                destinationItems: [],
                createdAt: new Date()
            }
        ]
        expect(combinedSnapshot(snapshots)?.sourceItems.map((item) => item.title)).toEqual(["A"])
        expect(combinedSnapshot([])).toBeUndefined()
    })

    test("reads playlist tracks from full-sync batches", () => {
        const track = {occurrenceId: "a", canonicalKey: "meta:a:artist", title: "A", artists: ["Artist"], providerItemId: "a", providerTrackId: "track-a"}
        const snapshots = [
            {
                taskId: new ObjectId(),
                batch: 0,
                playlists: [{...playlist(0), sourcePlaylistId: "source-a", destinationPlaylistId: "dest-a", sourceItems: [track], destinationItems: []}],
                sourceItems: [],
                destinationItems: [],
                createdAt: new Date()
            }
        ]
        expect(snapshotItemsForPlaylist(snapshots, "source-a", "source")).toEqual([track])
        expect(snapshotItemsForPlaylist(snapshots, "missing", "source")).toEqual([])
    })

    test("asks the snapshot only for displayed tracks that still have no length", () => {
        const accountId = new ObjectId()
        const withLength = {providerAccountId: accountId, playlistId: "dst", providerTrackId: "known", providerItemId: "item-known", title: "Known", artists: ["Ada"], durationMs: 1000}
        const missing = {providerAccountId: accountId, playlistId: "dst", providerTrackId: "missing", providerItemId: "item-missing", title: "Missing", artists: ["Bea"]}
        const runs = [{addedTracks: [withLength, missing], removedTracks: [], unmatchedTracks: []}]
        expect(tracksMissingDuration(runs)).toEqual([{providerTrackId: "missing", providerItemId: "item-missing"}])
        const taskId = new ObjectId()
        const pipeline = snapshotDurationPipeline(taskId, ["missing"], ["item-missing"])
        expect(pipeline[0]).toEqual({$match: {taskId}})
        expect(JSON.stringify(pipeline)).toContain("missing")
        expect(JSON.stringify(pipeline)).not.toContain("known")
        expect(
            snapshotForDurations([
                {providerTrackId: "missing", providerItemId: "item-missing", durationMs: 180000},
                {providerTrackId: "silent", providerItemId: "item-silent", durationMs: 0}
            ])?.sourceItems
        ).toEqual([
            {
                occurrenceId: "item-missing",
                canonicalKey: "missing",
                title: "",
                artists: [],
                providerItemId: "item-missing",
                providerTrackId: "missing",
                durationMs: 180000
            }
        ])
        expect(snapshotForDurations([])).toBeUndefined()
        expect(snapshotDurationPipeline(taskId, [], [])).toEqual([{$match: {_id: null}}])
    })
})
