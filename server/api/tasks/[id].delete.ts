// Delete a user's sync task and its recorded execution history.
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {assertSyncTaskIdle, idleLeaseFilter, throwIfSyncMutationMissed} from "../../domain/sync/task-activity"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"

// Scope deletion to the authenticated task owner.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    await assertSyncTaskIdle(task)
    const result = await db.syncTasks.deleteOne({_id: taskId, userId: user._id!, ...idleLeaseFilter()})
    if (!result.deletedCount) {
        await throwIfSyncMutationMissed(taskId, user._id!)
    }
    await Promise.all([db.syncSnapshots.deleteMany({taskId}), db.syncRuns.deleteMany({taskId})])
    logger.info("Tasks.delete", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`)
    return {ok: true}
})
