import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {AccountSnapshotPlaylist, SyncSnapshotDocument} from "../shared/types/domain"
import {accountSnapshotBatches, accountSnapshotPlaylistBatchSize, combinedSnapshot} from "../server/domain/sync/snapshot-batches"

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
})
