// Serialize, disconnect, and delete connected provider accounts and the users who own them.
import {randomUUID} from "node:crypto"
import {createError} from "h3"
import type {ObjectId} from "mongodb"
import type {ProviderAccountDocument, UserDocument} from "~~/shared/types/domain"
import {runningRunIsCurrent, syncLeaseDurationMs, syncTaskBusyMessage} from "../../shared/sync-task-activity"
import {collections} from "../data/collections"
import {isExtensionProvider} from "~~/shared/types/extension"
import {isExtensionOnline} from "./extension/bridge"
import {getAccountAdapter} from "./providers"
import {isProviderEnabled} from "../utils/provider-availability"
import {withUserLock} from "../utils/user-lock"
import logger from "../utils/logger"

// Subscription states that still renew and charge the customer.
export const renewingSubscriptionStatuses = new Set(["active", "trialing"])

// A deletion flag this old means the deleting process died, so it must not block the user forever.
export const userDeletionFlagTtlMs = 10 * 60 * 1000

// True while a recently started account deletion may still be removing this user's tasks.
export function isUserDeletionPending(user: Pick<UserDocument, "deletionStartedAt">, now = new Date()) {
    return Boolean(user.deletionStartedAt && now.getTime() - user.deletionStartedAt.getTime() < userDeletionFlagTtlMs)
}

// Resolve a playlist count without letting one provider failure hide the other accounts.
export async function playlistCountForAccount(account: ProviderAccountDocument): Promise<number | undefined> {
    if (account.connection === "extension") {
        if (!isExtensionProvider(account.provider) || !isExtensionOnline(account.userId.toHexString(), account.provider, account.extensionAccountId)) {
            return undefined
        }
    } else if (!isProviderEnabled(account.provider)) {
        return 0
    }
    if (needsAppleMusicAuthorization(account)) {
        return undefined
    }
    try {
        return (await getAccountAdapter(account).listPlaylists(account)).length
    } catch (error) {
        logger.warn("Accounts.playlistCount", account.provider, `Provider account ${account.externalAccountId}`, error)
        return undefined
    }
}

// Sign in with Apple connects the account. Playlist reads need a MusicKit user token from the browser.
function needsAppleMusicAuthorization(account: ProviderAccountDocument): boolean {
    return account.provider === "apple" && !account.musicUserToken
}

// Shape connected provider accounts for the API.
export async function serializeConnectedAccounts(accounts: ProviderAccountDocument[], includePlaylistCount: boolean) {
    return Promise.all(
        accounts.map(async (account) => ({
            id: account._id?.toHexString(),
            provider: account.provider,
            displayName: account.displayName,
            email: account.email,
            playlistCount: includePlaylistCount ? await playlistCountForAccount(account) : undefined,
            connectedAt: account.connectedAt,
            tokenExpiresAt: account.tokenExpiresAt,
            ...(account.connection === "extension" ? {connection: account.connection, online: isExtensionProvider(account.provider) && isExtensionOnline(account.userId.toHexString(), account.provider, account.extensionAccountId)} : {}),
            ...(needsAppleMusicAuthorization(account) ? {authorizationRequired: true} : {})
        }))
    )
}

// Delete a provider account and its stored tokens, unless a sync task uses it or it is the user's only way to sign in.
export async function disconnectProviderAccount(userId: ObjectId, accountId: ObjectId): Promise<void> {
    // Share the task-creation lock so a disconnect cannot remove an account a new task just read.
    await withUserLock(userId, async () => {
        const db = await collections()
        const account = await db.providerAccounts.findOne({_id: accountId, userId})
        if (!account) {
            throw createError({statusCode: 404, statusMessage: "Provider account not found"})
        }
        const taskCount = await db.syncTasks.countDocuments({userId, $or: [{"source.providerAccountId": accountId}, {"destination.providerAccountId": accountId}]})
        if (taskCount) {
            logger.warn("Accounts.disconnect", account.provider, `User ${userId.toHexString()}`, `Used by ${taskCount} sync tasks`)
            throw createError({statusCode: 409, statusMessage: `Delete the ${taskCount === 1 ? "sync task" : `${taskCount} sync tasks`} that use this account first`})
        }
        // Accounts linked through the browser extension cannot sign in, so they do not count as a way to sign in.
        if (account.connection !== "extension" && (await db.providerAccounts.countDocuments({userId, connection: {$ne: "extension"}})) <= 1) {
            logger.warn("Accounts.disconnect", account.provider, `User ${userId.toHexString()}`, "Only connected account")
            throw createError({statusCode: 409, statusMessage: "You sign in with this account. Connect another music service first, or delete your PlaylistSyncer account instead."})
        }
        await db.providerAccounts.deleteOne({_id: accountId, userId})
        logger.info("Accounts.disconnect", account.provider, `User ${userId.toHexString()}`, `Provider account ${account.externalAccountId}`)
    })
}

// Claim every idle task with the same lease predicate a new run uses, so deletion can see a busy task before any history is removed.
async function reserveTasksForDeletion(userId: ObjectId, leaseId: string): Promise<{ok: boolean; taskIds: ObjectId[]}> {
    const db = await collections()
    const tasks = await db.syncTasks.find({userId}).sort({createdAt: 1}).toArray()
    const now = new Date()
    const taskIds: ObjectId[] = []
    for (const task of tasks) {
        if (!task._id) {
            continue
        }
        const reserved = await db.syncTasks.updateOne({_id: task._id, userId, $or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lt: now}}]}, {$set: {leaseId, leaseExpiresAt: new Date(now.getTime() + syncLeaseDurationMs)}})
        if (!reserved.matchedCount) {
            const stillThere = await db.syncTasks.findOne({_id: task._id, userId}, {projection: {_id: 1}})
            if (stillThere) {
                return {ok: false, taskIds}
            }
            continue
        }
        const latest = await db.syncRuns.find({taskId: task._id}).sort({startedAt: -1}).limit(1).next()
        if (runningRunIsCurrent(latest)) {
            return {ok: false, taskIds}
        }
        taskIds.push(task._id)
    }
    return {ok: true, taskIds}
}

// Drop a deletion lease without touching a run that still holds a different one.
async function releaseTaskReservation(userId: ObjectId, leaseId: string): Promise<void> {
    const db = await collections()
    await db.syncTasks.updateMany({userId, leaseId}, {$unset: {leaseId: "", leaseExpiresAt: ""}})
}

// Delete the user with every task, run, snapshot, provider account, and session, unless a subscription would keep charging them.
export async function deleteUserAccount(user: UserDocument): Promise<void> {
    const userId = user._id!
    if (user.creemSubscriptionStatus && renewingSubscriptionStatuses.has(user.creemSubscriptionStatus)) {
        logger.warn("Accounts.deleteUser", `User ${userId.toHexString()}`, "Subscription is still active")
        throw createError({statusCode: 409, statusMessage: "Cancel your PRO subscription from Manage billing before deleting your account"})
    }
    // Hold the task-creation lock for the whole deletion so a new task cannot appear after the reservation.
    await withUserLock(userId, async () => {
        const db = await collections()
        const leaseId = randomUUID()
        let removed = false
        try {
            // Flag the user before removing tasks so a task insert that slipped past this process's lock still sees it.
            await db.users.updateOne({_id: userId}, {$set: {deletionStartedAt: new Date()}})
            const reservation = await reserveTasksForDeletion(userId, leaseId)
            if (!reservation.ok) {
                logger.warn("Accounts.deleteUser", `User ${userId.toHexString()}`, syncTaskBusyMessage)
                throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
            }
            const taskIds = reservation.taskIds
            await Promise.all([db.syncSnapshots.deleteMany({taskId: {$in: taskIds}}), db.syncRuns.deleteMany({taskId: {$in: taskIds}})])
            await db.syncTasks.deleteMany({userId})
            await db.providerAccounts.deleteMany({userId})
            await db.sessions.deleteMany({userId})
            await db.extensionClients.deleteMany({userId})
            await db.users.deleteOne({_id: userId})
            removed = true
            logger.info("Accounts.deleteUser", `User ${userId.toHexString()}`, `Tasks ${taskIds.length}`)
        } catch (error) {
            // A failure halfway through the reservation still holds leases and the flag, so clear both before the error leaves.
            if (!removed) await Promise.all([releaseTaskReservation(userId, leaseId), db.users.updateOne({_id: userId}, {$unset: {deletionStartedAt: ""}})])
            throw error
        }
    })
}
