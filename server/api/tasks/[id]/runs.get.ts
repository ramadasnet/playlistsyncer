// Return a task's latest run, or recent history for PRO accounts.
import {requireUser} from "../../../domain/auth/session"
import {resolveEntitlement} from "../../../domain/billing/entitlement"
import {loadSyncTaskDetail} from "../../../domain/sync/task-detail"
import {parseObjectId} from "../../../utils/object-id"

// Load owned runs, limiting Free accounts to the latest completed snapshot.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const detail = await loadSyncTaskDetail(user._id!, taskId, resolveEntitlement(user).tier)
    if (!detail) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    return {canBrowseHistory: detail.canBrowseHistory, runs: detail.runs}
})
