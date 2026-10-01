// Manually run a task after applying ownership and free-tier cooldown rules.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {resolveEntitlement} from "../../../domain/billing/entitlement"
import {manualSyncAvailableAt} from "../../../domain/sync/cooldown"
import {beginSyncTask, completeSyncTask} from "../../../domain/sync/engine"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"

// Reject runs during the cooldown, start the run immediately, and finish it in the background.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    const availableAt = manualSyncAvailableAt(resolveEntitlement(user).tier, task.lastSuccessAt)
    if (availableAt) {
        const retryAfterSeconds = Math.ceil((availableAt.getTime() - Date.now()) / 1000)
        setResponseHeader(event, "Retry-After", retryAfterSeconds)
        logger.warn("Tasks.run", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, `Free tier cooldown ${retryAfterSeconds}s`)
        throw createError({
            statusCode: 429,
            statusMessage: "Free accounts can manually synchronize once every 24 hours"
        })
    }
    logger.info("Tasks.run", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`)
    const context = await beginSyncTask(taskId, "manual")
    event.waitUntil(
        completeSyncTask(context).catch((error) => {
            logger.error("Tasks.runBackground", `Task ${taskId.toHexString()}`, `Run ${context.runId.toHexString()}`, error)
        })
    )
    return {status: "running", runId: context.runId.toHexString()}
})
