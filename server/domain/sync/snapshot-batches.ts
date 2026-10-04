// Store a full-sync snapshot as several documents so one field stays within Firestore's limit.
import type {Document, ObjectId} from "mongodb"
import type {AccountSnapshotPlaylist, CanonicalTrack, SyncRunDocument, SyncRunTrackReference, SyncSnapshotDocument} from "~~/shared/types/domain"
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

// Read every snapshot document stored for one sync task.
export async function loadTaskSnapshots(taskId: ObjectId): Promise<SyncSnapshotDocument[]> {
    const db = await collections()
    return db.syncSnapshots.find({taskId}).toArray()
}

// Return snapshot tracks for one playlist on either side of a sync task.
export function snapshotItemsForPlaylist(snapshots: readonly SyncSnapshotDocument[], playlistId: string, side: "source" | "destination"): CanonicalTrack[] {
    for (const snapshot of snapshots) {
        for (const playlist of snapshot.playlists || []) {
            const id = side === "source" ? playlist.sourcePlaylistId : playlist.destinationPlaylistId
            if (id === playlistId) {
                return side === "source" ? playlist.sourceItems : playlist.destinationItems
            }
        }
    }
    const single = snapshots.find((snapshot) => !snapshot.playlists?.length)
    if (single) {
        return side === "source" ? single.sourceItems : single.destinationItems
    }
    return []
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

type SnapshotDurationItem = Pick<CanonicalTrack, "providerTrackId" | "providerItemId" | "durationMs">

// Run tracks that still need a length from the snapshot.
export function tracksMissingDuration(runs: readonly Pick<SyncRunDocument, "addedTracks" | "removedTracks" | "unmatchedTracks">[]): Pick<SyncRunTrackReference, "providerTrackId" | "providerItemId">[] {
    return runs.flatMap((run) =>
        [...run.addedTracks, ...run.removedTracks, ...run.unmatchedTracks].flatMap((track) => {
            if (track.durationMs || (!track.providerTrackId && !track.providerItemId)) return []
            return [{providerTrackId: track.providerTrackId, ...(track.providerItemId ? {providerItemId: track.providerItemId} : {})}]
        })
    )
}

// Build the aggregation that returns durations for the requested tracks only.
export function snapshotDurationPipeline(taskId: ObjectId, trackIds: readonly string[], itemIds: readonly string[]): Document[] {
    const idMatches = [...(trackIds.length ? [{$in: ["$$item.providerTrackId", [...trackIds]]}] : []), ...(itemIds.length ? [{$in: ["$$item.providerItemId", [...itemIds]]}] : [])]
    if (!idMatches.length) return [{$match: {_id: null}}]
    return [
        {$match: {taskId}},
        {$sort: {batch: 1}},
        {
            $project: {
                items: {
                    $map: {
                        input: {
                            $filter: {
                                input: {
                                    $concatArrays: [
                                        {$ifNull: ["$sourceItems", []]},
                                        {$ifNull: ["$destinationItems", []]},
                                        {
                                            $reduce: {
                                                input: {$ifNull: ["$playlists", []]},
                                                initialValue: [],
                                                in: {
                                                    $concatArrays: ["$$value", {$ifNull: ["$$this.sourceItems", []]}, {$ifNull: ["$$this.destinationItems", []]}]
                                                }
                                            }
                                        }
                                    ]
                                },
                                as: "item",
                                cond: {$and: [{$gt: ["$$item.durationMs", 0]}, idMatches.length === 1 ? idMatches[0] : {$or: idMatches}]}
                            }
                        },
                        as: "item",
                        in: {providerTrackId: "$$item.providerTrackId", providerItemId: "$$item.providerItemId", durationMs: "$$item.durationMs"}
                    }
                }
            }
        },
        {$match: {"items.0": {$exists: true}}}
    ]
}

// Turn matched snapshot rows into the track list duration lookup expects.
export function snapshotForDurations(items: readonly SnapshotDurationItem[]): Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems"> | undefined {
    const sourceItems = items.flatMap((item) => {
        if (!item.durationMs || item.durationMs <= 0 || !item.providerTrackId) return []
        return [
            {
                occurrenceId: item.providerItemId || item.providerTrackId,
                canonicalKey: item.providerTrackId,
                title: "",
                artists: [],
                providerItemId: item.providerItemId || "",
                providerTrackId: item.providerTrackId,
                durationMs: item.durationMs
            }
        ]
    })
    if (!sourceItems.length) return undefined
    return {sourceItems, destinationItems: []}
}

// Read durations for the displayed tracks. Tracks that already have a length are not queried.
export async function snapshotDurationsForTracks(taskId: ObjectId, tracks: readonly Pick<SyncRunTrackReference, "providerTrackId" | "providerItemId">[]): Promise<SyncSnapshotDocument[]> {
    const trackIds = [...new Set(tracks.map((track) => track.providerTrackId).filter(Boolean))]
    const itemIds = [...new Set(tracks.flatMap((track) => (track.providerItemId ? [track.providerItemId] : [])))]
    if (!trackIds.length && !itemIds.length) return []
    const db = await collections()
    const matches = await db.syncSnapshots.aggregate<{items?: SnapshotDurationItem[]}>(snapshotDurationPipeline(taskId, trackIds, itemIds)).toArray()
    const lookup = snapshotForDurations(matches.flatMap((match) => match.items || []))
    if (!lookup) return []
    return [{taskId, sourceItems: lookup.sourceItems, destinationItems: [], createdAt: new Date()}]
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
