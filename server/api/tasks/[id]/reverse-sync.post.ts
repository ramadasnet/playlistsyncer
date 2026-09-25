// Run a registered reverse sync, such as restoring a deleted source playlist from its target.
import {z} from "zod"
import {reverseSyncCadences, reverseSyncDirections, reverseSyncReasons} from "~~/shared/reverse-sync"
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {runReverseSync} from "../../../domain/sync/engine"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"

const reverseSyncSchema = z.object({
    direction: z.enum(reverseSyncDirections),
    cadence: z.enum(reverseSyncCadences),
    reason: z.enum(reverseSyncReasons)
})

// Recovery is not a routine manual run, so the free-tier success cooldown does not apply.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const parsed = reverseSyncSchema.safeParse(await readBody(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: "This reverse sync is not available"})
    }
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    logger.info("Tasks.reverseSync", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, parsed.data.reason, parsed.data.direction, parsed.data.cadence)
    return runReverseSync(taskId, parsed.data)
})
