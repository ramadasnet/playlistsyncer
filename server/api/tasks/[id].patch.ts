// Update a sync task while enforcing ownership and plan locks.
import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {applyTaskEntitlement, entitlementEditBlockedMessage, isEntitlementLocked, retainedFreeTierTask} from "../../domain/billing/task-entitlement"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"

const updateSchema = z.object({status: z.enum(["active", "paused"])})

// Allow only valid active or paused transitions for the selected task.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const body = updateSchema.parse(await readBody(event))
    await applyTaskEntitlement(user)
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId: user._id!})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    if (isEntitlementLocked(task)) {
        logger.warn("Tasks.update", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, "Entitlement lock")
        throw createError({statusCode: 403, statusMessage: entitlementEditBlockedMessage})
    }
    if (body.status === "active" && resolveEntitlement(user).tier === "free") {
        const tasks = await db.syncTasks.find({userId: user._id!}).toArray()
        const retained = retainedFreeTierTask(tasks)
        if (!retained?._id?.equals(taskId)) {
            logger.warn("Tasks.update", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, "Free tier cannot enable extra tasks")
            throw createError({statusCode: 403, statusMessage: entitlementEditBlockedMessage})
        }
    }
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
    logger.info("Tasks.update", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`, `Status ${body.status}`)
    return {ok: true}
})
