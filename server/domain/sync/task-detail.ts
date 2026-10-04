// Load one owned sync task together with the runs its details page can show.
import type {ObjectId} from "mongodb"
import type {AccountTier, Provider} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {canViewRunHistory, proRunHistoryLimit, selectVisibleRuns, serializeSyncRun, serializeSyncTask} from "./history-visibility"
import {snapshotDurationsForTracks, tracksMissingDuration} from "./snapshot-batches"
import {fillMissingRunTrackDurations} from "./track-durations"

async function providerFor(accountId: ObjectId, userId: ObjectId): Promise<Provider | null> {
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: accountId, userId}, {projection: {provider: 1}})
    return account?.provider ?? null
}

// Return the task, its provider pair, and the runs visible at this account tier.
export async function loadSyncTaskDetail(userId: ObjectId, taskId: ObjectId, tier: AccountTier) {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId})
    if (!task) return null
    const [sourceProvider, destinationProvider, runs] = await Promise.all([
        providerFor(task.source.providerAccountId, userId),
        providerFor(task.destination.providerAccountId, userId),
        db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(proRunHistoryLimit).toArray()
    ])
    const visibleRuns = selectVisibleRuns(runs, tier)
    const runsWithDurations = await fillMissingRunTrackDurations(userId, visibleRuns, [task.source.providerAccountId, task.destination.providerAccountId])
    // Only the tracks still missing a length are looked up, so the page does not load every playlist in the account snapshot.
    const snapshots = await snapshotDurationsForTracks(taskId, tracksMissingDuration(runsWithDurations))
    const latest = runsWithDurations[0]
    return {
        task: serializeSyncTask(
            task,
            latest
                ? {
                      status: latest.status,
                      additions: latest.additions,
                      removals: latest.removals,
                      conflicts: latest.conflicts,
                      skipped: latest.skipped,
                      startedAt: latest.startedAt,
                      progress: latest.progress
                  }
                : undefined,
            tier
        ),
        sourceProvider,
        destinationProvider,
        playlistMappings: (task.playlistMappings || []).map((mapping) => ({
            sourcePlaylistId: mapping.sourcePlaylistId,
            destinationPlaylistId: mapping.destinationPlaylistId,
            name: mapping.name
        })),
        canBrowseHistory: canViewRunHistory(tier),
        runs: runsWithDurations.map((run, index) => serializeSyncRun(run, task, snapshots.length ? snapshots : undefined, runsWithDurations.slice(0, index)))
    }
}
