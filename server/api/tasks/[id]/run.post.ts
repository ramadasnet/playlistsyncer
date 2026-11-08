// Manually run an owned, idle task.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {assertExtensionAccountsOnline} from "../../../domain/extension/clients"
import {beginSyncTask, completeSyncTask} from "../../../domain/sync/engine"
import {assertSyncTaskIdle} from "../../../domain/sync/task-activity"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"
import {startTrackedSyncRun} from "../../../utils/shutdown"
import {enforceProviderRequestLimit} from "../../../utils/user-rate-limit"

// Start the run immediately and finish it in the background.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    await assertSyncTaskIdle(task)
    if (task.browserExtension) {
        assertExtensionAccountsOnline(await db.providerAccounts.find({_id: {$in: [task.source.providerAccountId, task.destination.providerAccountId]}, userId: user._id!}).toArray())
    }
    logger.info("Tasks.run", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`)
    const {context, finished} = await startTrackedSyncRun(() => beginSyncTask(taskId, "manual"), completeSyncTask)
    event.waitUntil(
        finished.catch((error) => {
            logger.error("Tasks.runBackground", `Task ${taskId.toHexString()}`, `Run ${context.runId.toHexString()}`, error)
        })
    )
    return {status: "running", runId: context.runId.toHexString()}
})
