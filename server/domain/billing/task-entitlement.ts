import type {ObjectId} from "mongodb"
import type {SyncTaskDocument, UserDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {resolveEntitlement} from "./entitlement"

export const entitlementEditBlockedMessage = "A PRO subscription is required to edit this sync task"

type TaskEntitlementFields = Pick<SyncTaskDocument, "_id" | "mode" | "pauseReason" | "createdAt">

export function retainedFreeTierTask<T extends Pick<SyncTaskDocument, "mode" | "createdAt">>(
    tasks: T[]
): T | undefined {
    return [...tasks]
        .filter((task) => task.mode !== "account")
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0]
}

export function isEntitlementLocked(task: Pick<SyncTaskDocument, "pauseReason">): boolean {
    return task.pauseReason === "entitlement"
}

export function planTaskEntitlement(
    tasks: TaskEntitlementFields[],
    isPro: boolean
): {pauseIds: ObjectId[]; resumeIds: ObjectId[]} {
    const withIds = tasks.filter((task): task is TaskEntitlementFields & {_id: ObjectId} => Boolean(task._id))
    if (isPro) {
        return {
            pauseIds: [],
            resumeIds: withIds.filter((task) => task.pauseReason === "entitlement").map((task) => task._id)
        }
    }
    const retainedId = retainedFreeTierTask(withIds)?._id
    return {
        pauseIds: withIds
            .filter((task) => !task._id.equals(retainedId) && task.pauseReason !== "user")
            .map((task) => task._id),
        resumeIds: withIds
            .filter((task) => task._id.equals(retainedId) && task.pauseReason === "entitlement")
            .map((task) => task._id)
    }
}

export async function applyTaskEntitlement(user: Pick<UserDocument, "_id" | "email" | "tier">): Promise<void> {
    if (!user._id) {
        return
    }
    const db = await collections()
    const isPro = resolveEntitlement(user).tier === "pro"
    if (isPro) {
        const resumed = await db.syncTasks.updateMany(
            {userId: user._id, pauseReason: "entitlement"},
            {$set: {status: "active", nextRunAt: new Date(), updatedAt: new Date()}, $unset: {pauseReason: ""}}
        )
        if (resumed.modifiedCount) {
            logger.info(
                "Billing.applyTaskEntitlement",
                `User ${user._id.toHexString()}`,
                `Resumed tasks ${resumed.modifiedCount}`
            )
        }
        return
    }
    const retainedTask = await db.syncTasks
        .find({userId: user._id, mode: {$ne: "account"}})
        .sort({createdAt: 1})
        .limit(1)
        .next()
    const paused = await db.syncTasks.updateMany(
        {
            userId: user._id,
            ...(retainedTask?._id ? {_id: {$ne: retainedTask._id}} : {}),
            pauseReason: {$ne: "user"}
        },
        {
            $set: {status: "paused", pauseReason: "entitlement", updatedAt: new Date()},
            $unset: {leaseId: "", leaseExpiresAt: ""}
        }
    )
    if (paused.modifiedCount) {
        logger.warn(
            "Billing.applyTaskEntitlement",
            `User ${user._id.toHexString()}`,
            `Paused tasks ${paused.modifiedCount}`
        )
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
        logger.info(
            "Billing.applyTaskEntitlement",
            `User ${user._id.toHexString()}`,
            `Restored free-tier task ${retainedTask._id?.toHexString()}`
        )
    }
}
