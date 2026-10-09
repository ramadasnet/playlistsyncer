// Reject user actions while a sync task still holds a lease or a current run.
import {randomUUID} from "node:crypto"
import type {ObjectId} from "mongodb"
import type {SyncTaskDocument} from "~~/shared/types/domain"
import {isSyncInProgress, syncLeaseDurationMs, syncTaskBusyMessage} from "../../../shared/sync-task-activity"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"

// Match tasks whose lease is missing or already expired.
export function idleLeaseFilter(now = new Date()) {
    return {$or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lte: now}}]}
}

// Re-read the lease and the latest run so a lease acquired before the run row exists still blocks.
export async function assertSyncTaskIdle(task: SyncTaskDocument) {
    if (!task._id) return
    const db = await collections()
    const fresh = await db.syncTasks.findOne({_id: task._id}, {projection: {leaseExpiresAt: 1}})
    const latest = await db.syncRuns.find({taskId: task._id}).sort({startedAt: -1}).limit(1).next()
    if (!isSyncInProgress({leaseExpiresAt: fresh?.leaseExpiresAt, latestRun: latest})) return
    logger.warn("Sync.taskBusy", `Task ${task._id.toHexString()}`, syncTaskBusyMessage)
    throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
}

// A conditional write that matches nothing is a live lease, unless the task is already gone.
export async function throwIfSyncMutationMissed(taskId: ObjectId, userId: ObjectId): Promise<never> {
    const db = await collections()
    const fresh = await db.syncTasks.findOne({_id: taskId, userId}, {projection: {_id: 1}})
    if (!fresh) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    logger.warn("Sync.taskBusy", `Task ${taskId.toHexString()}`, syncTaskBusyMessage)
    throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
}

// Hold the task lease for a user action, so no sync can start and overwrite what the action saves.
export async function withTaskLease<T>(task: SyncTaskDocument, action: () => Promise<T>): Promise<T> {
    await assertSyncTaskIdle(task)
    const db = await collections()
    const leaseId = randomUUID()
    const now = new Date()
    const leased = await db.syncTasks.findOneAndUpdate({_id: task._id!, ...idleLeaseFilter(now)}, {$set: {leaseId, leaseExpiresAt: new Date(now.getTime() + syncLeaseDurationMs)}})
    if (!leased) {
        logger.warn("Sync.taskBusy", `Task ${task._id!.toHexString()}`, syncTaskBusyMessage)
        throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
    }
    try {
        return await action()
    } finally {
        await db.syncTasks.updateOne({_id: task._id!, leaseId}, {$unset: {leaseId: "", leaseExpiresAt: ""}})
    }
}
