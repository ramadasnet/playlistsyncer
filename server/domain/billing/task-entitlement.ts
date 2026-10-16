// Keep sync tasks aligned with the user's current billing entitlement.
import type {ObjectId} from "mongodb"
import type {SyncTaskDocument, UserDocument} from "~~/shared/types/domain"
import {parseSubscriptionRequiredAt} from "../../../shared/trial"
import {collections} from "../../data/collections"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {isShuttingDown} from "../../utils/shutdown"
import {idleLeaseFilter} from "../sync/task-activity"
import {resolveEntitlement} from "./entitlement"

export const entitlementEditBlockedMessage = "A PRO subscription is required to edit this sync task"

type TaskEntitlementFields = Pick<SyncTaskDocument, "_id" | "mode" | "pauseReason" | "createdAt">

// Select the oldest playlist task retained for a free-tier account.
export function retainedFreeTierTask<T extends Pick<SyncTaskDocument, "mode" | "createdAt">>(tasks: T[]): T | undefined {
    return [...tasks].filter((task) => task.mode !== "account").sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0]
}

// Check whether a task was paused because of billing entitlement.
export function isEntitlementLocked(task: Pick<SyncTaskDocument, "pauseReason">): boolean {
    return task.pauseReason === "entitlement"
}

// Check whether a task is beyond the free-tier task allowance.
export function isPlanLockedTask(task: Pick<SyncTaskDocument, "_id" | "mode" | "createdAt">, tasks: Pick<SyncTaskDocument, "_id" | "mode" | "createdAt">[], isPro: boolean): boolean {
    if (isPro || !task._id) {
        return false
    }
    const retained = retainedFreeTierTask(tasks)
    return !retained?._id?.equals(task._id)
}

// Calculate task pauses and resumes required by a plan change.
export function planTaskEntitlement(tasks: TaskEntitlementFields[], isPro: boolean): {pauseIds: ObjectId[]; resumeIds: ObjectId[]} {
    const withIds = tasks.filter((task): task is TaskEntitlementFields & {_id: ObjectId} => Boolean(task._id))
    if (isPro) {
        return {
            pauseIds: [],
            resumeIds: withIds.filter((task) => task.pauseReason === "entitlement").map((task) => task._id)
        }
    }
    const retainedId = retainedFreeTierTask(withIds)?._id
    return {
        pauseIds: withIds.filter((task) => !task._id.equals(retainedId) && task.pauseReason !== "user" && task.pauseReason !== "entitlement").map((task) => task._id),
        resumeIds: withIds.filter((task) => task._id.equals(retainedId) && task.pauseReason === "entitlement").map((task) => task._id)
    }
}

// Apply entitlement-driven task state changes in the database.
export async function applyTaskEntitlement(user: Pick<UserDocument, "_id" | "email" | "tier">): Promise<void> {
    if (!user._id) {
        return
    }
    const db = await collections()
    const isPro = resolveEntitlement(user).tier === "pro"
    if (isPro) {
        const resumed = await db.syncTasks.updateMany({userId: user._id, pauseReason: "entitlement"}, {$set: {status: "active", nextRunAt: new Date(), updatedAt: new Date()}, $unset: {pauseReason: ""}})
        if (resumed.modifiedCount) {
            logger.info("Billing.applyTaskEntitlement", `User ${user._id.toHexString()}`, `Resumed tasks ${resumed.modifiedCount}`)
        }
        return
    }
    const retainedTask = await db.syncTasks.find({userId: user._id, mode: "playlist"}).sort({createdAt: 1}).limit(1).next()
    const now = new Date()
    const pauseFilter = {
        userId: user._id,
        ...(retainedTask?._id ? {_id: {$ne: retainedTask._id}} : {}),
        pauseReason: {$nin: ["user", "entitlement"] as const}
    }
    // An active manual-match lease stays in place so another writer cannot take the task mid-action.
    const pausedIdle = await db.syncTasks.updateMany({...pauseFilter, ...idleLeaseFilter(now)}, {$set: {status: "paused", pauseReason: "entitlement", updatedAt: now}, $unset: {leaseId: "", leaseExpiresAt: ""}})
    const pausedBusy = await db.syncTasks.updateMany({...pauseFilter, leaseExpiresAt: {$gt: now}}, {$set: {status: "paused", pauseReason: "entitlement", updatedAt: now}})
    const pausedCount = (pausedIdle.modifiedCount || 0) + (pausedBusy.modifiedCount || 0)
    if (pausedCount) {
        logger.warn("Billing.applyTaskEntitlement", `User ${user._id.toHexString()}`, `Paused tasks ${pausedCount}`)
    }
    if (retainedTask && retainedTask.pauseReason === "entitlement") {
        await db.syncTasks.updateOne(
            {_id: retainedTask._id},
            {
                $set: {
                    status: "active",
                    nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    updatedAt: new Date()
                },
                $unset: {pauseReason: ""}
            }
        )
        logger.info("Billing.applyTaskEntitlement", `User ${user._id.toHexString()}`, `Restored free-tier task ${retainedTask._id?.toHexString()}`)
    }
}

/**
 * Reverts accounts whose only PRO access was the complimentary promotion back to Free once that window has ended,
 * by applying the Free-tier task locks without waiting for their next login or due sync.
 * @param options.stopping Returns true when the process should stop before the next account. Defaults to process shutdown.
 * @param options.now Instant to compare against the configured cutoff.
 * @returns Accounts reverted, and whether the pass stopped early.
 */
export async function revertExpiredPromotionalAccess(options: {stopping?: () => boolean; now?: Date} = {}): Promise<{users: number; stopped: boolean}> {
    const now = options.now ?? new Date()
    // Without a configured cutoff there was no promotion, and an unexpired one still grants effective PRO.
    const requiredAt = parseSubscriptionRequiredAt(getServerConfig().proSubscriptionRequiredAt)
    if (!requiredAt || now < requiredAt) {
        return {users: 0, stopped: false}
    }
    const stopping = options.stopping ?? isShuttingDown
    const db = await collections()
    // Paid accounts keep tier "pro" in the database; every "free" account's PRO access came from the promotion.
    const candidates = await db.users.find({tier: "free"}).toArray()
    let users = 0
    let failed = 0
    let stopped = false
    for (const user of candidates) {
        if (stopping()) {
            stopped = true
            break
        }
        try {
            await applyTaskEntitlement(user)
            users++
        } catch (error) {
            failed++
            logger.error("Billing.revertPromotionalAccess", error, `User ${user._id?.toHexString()}`)
        }
    }
    logger.info("Billing.revertPromotionalAccess", `Accounts ${users}`, stopped ? "Stopped early" : "Finished")
    return {users, stopped}
}
