// Return a task's latest run, or recent history for PRO accounts.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {resolveEntitlement} from "../../../domain/billing/entitlement"
import {canViewRunHistory, runHistoryLimitFor, serializeSyncRun} from "../../../domain/sync/history-visibility"
import {fillMissingRunTrackDurations} from "../../../domain/sync/track-durations"
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
    const runsWithDurations = await fillMissingRunTrackDurations(user._id!, runs, [task.source.providerAccountId, task.destination.providerAccountId])
    return {
        canBrowseHistory: canViewRunHistory(tier),
        runs: runsWithDurations.map((run, index) => serializeSyncRun(run, task, snapshot || undefined, runsWithDurations.slice(0, index)))
    }
})
