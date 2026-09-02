import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"

const updateSchema = z.object({status: z.enum(["active", "paused"])})

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const body = updateSchema.parse(await readBody(event))
    const db = await collections()
    const result = await db.syncTasks.updateOne(
        {_id: taskId, userId: user._id!},
        {
            $set: {...body, ...(body.status === "paused" ? {pauseReason: "user" as const} : {}), updatedAt: new Date()},
            ...(body.status === "active" ? {$unset: {pauseReason: ""}} : {})
        }
    )
    if (!result.matchedCount) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    logger.info(
        "Tasks.update",
        `Task ${taskId.toHexString()}`,
        `User ${user._id!.toHexString()}`,
        `Status ${body.status}`
    )
    return {ok: true}
})
