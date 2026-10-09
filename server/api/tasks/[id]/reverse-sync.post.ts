// Run a registered reverse sync, such as restoring a deleted source playlist from its target.
import {z} from "zod"
import {reverseSyncCadences, reverseSyncDirections, reverseSyncReasons} from "~~/shared/reverse-sync"
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {beginSyncTask, completeSyncTask} from "../../../domain/sync/engine"
import {assertReverseSyncAvailable} from "../../../domain/sync/reverse-sync"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"
import {startTrackedSyncRun} from "../../../utils/shutdown"
import {enforceProviderRequestLimit} from "../../../utils/user-rate-limit"

const reverseSyncSchema = z.object({
    direction: z.enum(reverseSyncDirections),
    cadence: z.enum(reverseSyncCadences),
    reason: z.enum(reverseSyncReasons)
})

// Recovery is not a routine manual run, so the free-tier success cooldown does not apply.
// A restore can outlast the HTTP idle timeout, so it finishes in the background like a manual run.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
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
    const runs = await db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(50).toArray()
    assertReverseSyncAvailable(runs, parsed.data)
    logger.info("Tasks.reverseSync", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, parsed.data.reason, parsed.data.direction, parsed.data.cadence)
    const {context, finished} = await startTrackedSyncRun(() => beginSyncTask(taskId, "manual", parsed.data), completeSyncTask)
    event.waitUntil(
        finished.catch((error) => {
            logger.error("Tasks.reverseSyncBackground", `Task ${taskId.toHexString()}`, `Run ${context.runId.toHexString()}`, error)
        })
    )
    return {status: "running", runId: context.runId.toHexString()}
})
