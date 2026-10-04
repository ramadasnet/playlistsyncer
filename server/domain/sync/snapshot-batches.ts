// Store a full-sync snapshot as several documents so one field stays within Firestore's limit.
import type {ObjectId} from "mongodb"
import type {AccountSnapshotPlaylist, SyncSnapshotDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"

// Thirty playlists stay under the 4 MiB field limit for ordinary track metadata.
export const accountSnapshotPlaylistBatchSize = 30

// Group playlist snapshots into fixed-size batches.
export function accountSnapshotBatches<T>(playlists: T[], size = accountSnapshotPlaylistBatchSize): T[][] {
    const batches: T[][] = []
    for (let index = 0; index < playlists.length; index += size) {
        batches.push(playlists.slice(index, index + size))
    }
    return batches
}

// Flatten playlist and full-sync batches into the track arrays duration lookup expects.
export function combinedSnapshot(snapshots: SyncSnapshotDocument[]): Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems"> | undefined {
    if (!snapshots.length) return undefined
    const sourceItems = []
    const destinationItems = []
    for (const snapshot of snapshots) {
        sourceItems.push(...snapshot.sourceItems, ...(snapshot.playlists || []).flatMap((playlist) => playlist.sourceItems))
        destinationItems.push(...snapshot.destinationItems, ...(snapshot.playlists || []).flatMap((playlist) => playlist.destinationItems))
    }
    return {sourceItems, destinationItems}
}

// Replace a task's full-sync snapshot with batches of at most 30 playlists.
export async function saveAccountSnapshotBatches(taskId: ObjectId, playlists: AccountSnapshotPlaylist[]): Promise<void> {
    const db = await collections()
    const batches = accountSnapshotBatches(playlists)
    for (const [batch, playlistsInBatch] of batches.entries()) {
        await db.syncSnapshots.updateOne({taskId, batch}, {$set: {playlists: playlistsInBatch, sourceItems: [], destinationItems: [], createdAt: new Date()}}, {upsert: true})
    }
    await db.syncSnapshots.deleteMany({taskId, batch: {$gte: batches.length}})
}
