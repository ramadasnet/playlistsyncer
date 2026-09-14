// Return a task's latest run, or recent history for PRO accounts.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {resolveEntitlement} from "../../../domain/billing/entitlement"
import {canViewRunHistory, runHistoryLimitFor, runNeedsUnmatchedBackfill, serializeSyncRun, unmatchedTracksFromSnapshot} from "../../../domain/sync/history-visibility"
import {parseObjectId} from "../../../utils/object-id"

// Load owned runs, limiting Free accounts to the latest completed snapshot.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    const tier = resolveEntitlement(user).tier
    const [runs, snapshot] = await Promise.all([db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(runHistoryLimitFor(tier)).toArray(), db.syncSnapshots.findOne({taskId})])
    const latest = runs[0]
    if (latest && snapshot && runNeedsUnmatchedBackfill(latest) && latest.status !== "running" && latest.status !== "failed") {
        const unmatchedTracks = unmatchedTracksFromSnapshot(snapshot, task)
        if (unmatchedTracks.length) {
            latest.unmatchedTracks = unmatchedTracks
            await db.syncRuns.updateOne({_id: latest._id, $or: [{unmatchedTracks: {$exists: false}}, {unmatchedTracks: {$size: 0}}]}, {$set: {unmatchedTracks}})
        }
    }
    return {
        canBrowseHistory: canViewRunHistory(tier),
        runs: runs.map(serializeSyncRun)
    }
})
