// Serialize, disconnect, and delete connected provider accounts and the users who own them.
import {createError} from "h3"
import type {ObjectId} from "mongodb"
import type {ProviderAccountDocument, UserDocument} from "~~/shared/types/domain"
import {collections} from "../data/collections"
import {getProviderAdapter} from "./providers"
import {assertSyncTaskIdle} from "./sync/task-activity"
import {isProviderEnabled} from "../utils/provider-availability"
import logger from "../utils/logger"

// Subscription states that still renew and charge the customer.
const renewingSubscriptionStatuses = new Set(["active", "trialing"])

// Resolve a playlist count without letting one provider failure hide the other accounts.
export async function playlistCountForAccount(account: ProviderAccountDocument): Promise<number | undefined> {
    if (!isProviderEnabled(account.provider)) {
        return 0
    }
    try {
        return (await getProviderAdapter(account.provider).listPlaylists(account)).length
    } catch (error) {
        logger.warn("Accounts.playlistCount", account.provider, `Provider account ${account.externalAccountId}`, error)
        return undefined
    }
}

export async function serializeConnectedAccounts(accounts: ProviderAccountDocument[], includePlaylistCount: boolean) {
    return Promise.all(
        accounts.map(async (account) => ({
            id: account._id?.toHexString(),
            provider: account.provider,
            displayName: account.displayName,
            email: account.email,
            playlistCount: includePlaylistCount ? await playlistCountForAccount(account) : undefined,
            connectedAt: account.connectedAt,
            tokenExpiresAt: account.tokenExpiresAt
        }))
    )
}

// Delete a provider account and its stored tokens, unless a sync task uses it or it is the user's only way to sign in.
export async function disconnectProviderAccount(userId: ObjectId, accountId: ObjectId): Promise<void> {
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
    if ((await db.providerAccounts.countDocuments({userId})) <= 1) {
        logger.warn("Accounts.disconnect", account.provider, `User ${userId.toHexString()}`, "Only connected account")
        throw createError({statusCode: 409, statusMessage: "You sign in with this account. Connect another music service first, or delete your PlaylistSyncer account instead."})
    }
    await db.providerAccounts.deleteOne({_id: accountId, userId})
    logger.info("Accounts.disconnect", account.provider, `User ${userId.toHexString()}`, `Provider account ${account.externalAccountId}`)
}

// Delete the user with every task, run, snapshot, provider account, and session, unless a subscription would keep charging them.
export async function deleteUserAccount(user: UserDocument): Promise<void> {
    const userId = user._id!
    if (user.creemSubscriptionStatus && renewingSubscriptionStatuses.has(user.creemSubscriptionStatus)) {
        logger.warn("Accounts.deleteUser", `User ${userId.toHexString()}`, "Subscription is still active")
        throw createError({statusCode: 409, statusMessage: "Cancel your PRO subscription from Manage billing before deleting your account"})
    }
    const db = await collections()
    const tasks = await db.syncTasks.find({userId}).toArray()
    for (const task of tasks) {
        await assertSyncTaskIdle(task)
    }
    const taskIds = tasks.map((task) => task._id)
    await Promise.all([db.syncSnapshots.deleteMany({taskId: {$in: taskIds}}), db.syncRuns.deleteMany({taskId: {$in: taskIds}})])
    await db.syncTasks.deleteMany({userId})
    await db.providerAccounts.deleteMany({userId})
    await db.sessions.deleteMany({userId})
    await db.users.deleteOne({_id: userId})
    logger.info("Accounts.deleteUser", `User ${userId.toHexString()}`, `Tasks ${tasks.length}`)
}
