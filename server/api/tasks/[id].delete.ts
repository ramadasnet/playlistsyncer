// Delete a user's sync task and its recorded execution history.
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"

// Scope deletion to the authenticated task owner.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const db = await collections()
    const result = await db.syncTasks.deleteOne({_id: taskId, userId: user._id!})
    if (!result.deletedCount) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    await Promise.all([db.syncSnapshots.deleteOne({taskId}), db.syncRuns.deleteMany({taskId})])
    logger.info("Tasks.delete", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`)
    return {ok: true}
})
