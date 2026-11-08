// Update an owned sync task while it is idle.
import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {assertSyncTaskIdle, idleLeaseFilter, throwIfSyncMutationMissed} from "../../domain/sync/task-activity"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"

const updateSchema = z.object({status: z.enum(["active", "paused"])})

// Allow only valid active or paused transitions for the selected task.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const body = updateSchema.parse(await readBody(event))
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    await assertSyncTaskIdle(task)
    const result = await db.syncTasks.updateOne(
        {_id: taskId, userId: user._id!, ...idleLeaseFilter()},
        {
            $set: {...body, ...(body.status === "paused" ? {pauseReason: "user" as const} : {}), updatedAt: new Date()},
            ...(body.status === "active" ? {$unset: {pauseReason: ""}} : {})
        }
    )
    if (!result.matchedCount) {
        await throwIfSyncMutationMissed(taskId, user._id!)
    }
    logger.info("Tasks.update", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, `Status ${body.status}`)
    return {ok: true}
})
