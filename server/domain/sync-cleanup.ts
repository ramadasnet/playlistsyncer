// Delete old sync runs, expired documents, and inactive users without sync tasks, warning those users by email first.
import type {Filter} from "mongodb"
import type {UserDocument} from "~~/shared/types/domain"
import {collections, syncRunRetentionSeconds, webhookEventRetentionSeconds} from "../data/collections"
import logger from "../utils/logger"
import {isShuttingDown} from "../utils/shutdown"
import {deleteUserAccount, renewingSubscriptionStatuses} from "./accounts"
import type {OutboundEmail} from "./mail/send"
import {escapeHtml} from "./mail/weekly-sync-summary"

export interface SyncCleanupOptions {
    // Sync runs that started before this many months ago are deleted.
    runRetentionMonths: number
    // Users without tasks who have not logged in for this many months get a warning email.
    warnAfterMonths: number
    // Users without tasks who have not logged in for this many months can be deleted.
    deleteAfterMonths: number
    // Days between the warning email and the deletion.
    deletionGraceDays: number
    // Maximum users to warn, and maximum users to delete, on one call.
    limit: number
}

export const syncCleanupDefaults: SyncCleanupOptions = {
    runRetentionMonths: 3,
    warnAfterMonths: 12,
    deleteAfterMonths: 12,
    deletionGraceDays: 30,
    limit: 100
}

const dayMs = 24 * 60 * 60 * 1000

/**
 * Moves a date by whole calendar months in UTC.
 * @param date Starting date.
 * @param months Months to add, negative to go back.
 */
export function addMonths(date: Date, months: number): Date {
    const result = new Date(date)
    result.setUTCMonth(result.getUTCMonth() + months)
    return result
}

/**
 * Instant before which a sync run is deleted.
 * The configured retention and the 180-day cap both apply, so the more recent cutoff wins.
 * @param now When the cleanup runs.
 * @param runRetentionMonths Months of sync runs to keep, before the 180-day cap.
 */
export function syncRunDeletionCutoff(now: Date, runRetentionMonths: number): Date {
    const retentionCutoff = addMonths(now, -runRetentionMonths)
    const ttlCutoff = new Date(now.getTime() - syncRunRetentionSeconds * 1000)
    return retentionCutoff > ttlCutoff ? retentionCutoff : ttlCutoff
}

/**
 * Earliest date the cleanup can delete a user who was warned now.
 * @param lastLoginAt The user's last login.
 * @param now When the warning is sent.
 */
export function inactiveAccountDeletionDate(lastLoginAt: Date, now: Date, options: Pick<SyncCleanupOptions, "deleteAfterMonths" | "deletionGraceDays">): Date {
    return new Date(Math.max(addMonths(lastLoginAt, options.deleteAfterMonths).getTime(), now.getTime() + options.deletionGraceDays * dayMs))
}

// Tell an inactive user their account will be deleted unless they log in.
export function buildInactiveAccountEmail(input: {to: string; displayName?: string; deletionDate: Date; appUrl?: string; appName?: string}): OutboundEmail {
    const appName = input.appName || "PlaylistSyncer"
    const greeting = input.displayName?.trim() ? `Hi ${input.displayName.trim()},` : "Hi,"
    const date = input.deletionDate.toLocaleDateString("en-US", {year: "numeric", month: "long", day: "numeric", timeZone: "UTC"})
    const intro = `You have not logged in to ${appName} for a long time, and your account has no sync tasks.`
    const warning = `We will delete your account and its connected music services on or after ${date}. To keep it, just log in before then.`
    const loginUrl = input.appUrl ? `${input.appUrl}/login` : undefined
    const text = [greeting, "", intro, warning, ...(loginUrl ? ["", `Log in to ${appName}:`, loginUrl] : [])].join("\n")
    const html = [`<p>${escapeHtml(greeting)}</p>`, `<p>${escapeHtml(intro)}</p>`, `<p>${escapeHtml(warning)}</p>`, ...(loginUrl ? [`<p><a href="${escapeHtml(loginUrl)}">Log in to ${escapeHtml(appName)}</a></p>`] : [])].join("")
    return {to: input.to, subject: `Your ${appName} account will be deleted soon`, text, html}
}

/**
 * Deletes old sync runs and other expired documents, deletes inactive users without tasks, then warns the users who will be deleted next.
 * Users with a renewing subscription are never warned or deleted.
 * Expired sessions, OAuth transactions, and search misses are deleted here as well as by TTL indexes, so a database that cannot create those indexes still drops them.
 * @param input.send Delivers one email, and returns false when mail is not configured.
 */
export async function runSyncCleanup(input: {options?: Partial<SyncCleanupOptions>; now?: Date; send: (message: OutboundEmail) => Promise<boolean>; appUrl?: string}) {
    const options = {...syncCleanupDefaults, ...input.options}
    const now = input.now ?? new Date()
    const db = await collections()
    const result = {runsDeleted: 0, sessionsDeleted: 0, oauthTransactionsDeleted: 0, searchMissesDeleted: 0, webhookEventsDeleted: 0, usersDeleted: 0, usersWarned: 0, failed: 0}

    const [runs, sessions, oauthTransactions, searchMisses, webhookEvents] = await Promise.all([
        db.syncRuns.deleteMany({startedAt: {$lt: syncRunDeletionCutoff(now, options.runRetentionMonths)}}),
        db.sessions.deleteMany({expiresAt: {$lt: now}}),
        db.oauthTransactions.deleteMany({expiresAt: {$lt: now}}),
        db.searchMisses.deleteMany({expiresAt: {$lt: now}}),
        db.webhookEvents.deleteMany({processedAt: {$lt: new Date(now.getTime() - webhookEventRetentionSeconds * 1000)}})
    ])
    result.runsDeleted = runs.deletedCount
    result.sessionsDeleted = sessions.deletedCount
    result.oauthTransactionsDeleted = oauthTransactions.deletedCount
    result.searchMissesDeleted = searchMisses.deletedCount
    result.webhookEventsDeleted = webhookEvents.deletedCount

    const notRenewing = {creemSubscriptionStatus: {$nin: [...renewingSubscriptionStatuses]}}
    const hasTasks = async (user: UserDocument) => Boolean(await db.syncTasks.countDocuments({userId: user._id!}, {limit: 1}))

    // A user with an email is deleted only after the grace period that follows the warning.
    const deletable: Filter<UserDocument> = {
        lastLoginAt: {$lt: addMonths(now, -options.deleteAfterMonths)},
        ...notRenewing,
        $or: [{inactivityWarningSentAt: {$lte: new Date(now.getTime() - options.deletionGraceDays * dayMs)}}, {email: {$exists: false}}, {email: ""}]
    }
    for await (const user of db.users.find(deletable).sort({lastLoginAt: 1})) {
        if (result.usersDeleted >= options.limit || isShuttingDown()) break
        if (await hasTasks(user)) continue
        try {
            await deleteUserAccount(user)
            result.usersDeleted++
        } catch (error) {
            logger.error("SyncCleanup.deleteUser", `User ${user._id!.toHexString()}`, error)
            result.failed++
        }
    }

    const warnable: Filter<UserDocument> = {
        lastLoginAt: {$lt: addMonths(now, -options.warnAfterMonths)},
        inactivityWarningSentAt: {$exists: false},
        email: {$type: "string", $ne: ""},
        ...notRenewing
    }
    for await (const user of db.users.find(warnable).sort({lastLoginAt: 1})) {
        if (result.usersWarned >= options.limit || isShuttingDown()) break
        if (await hasTasks(user)) continue
        try {
            const message = buildInactiveAccountEmail({
                to: user.email!,
                displayName: user.displayName,
                deletionDate: inactiveAccountDeletionDate(user.lastLoginAt!, now, options),
                appUrl: input.appUrl
            })
            // Without mail delivery nobody can be warned, so stop instead of logging the same warning for every user.
            if (!(await input.send(message))) break
            await db.users.updateOne({_id: user._id}, {$set: {inactivityWarningSentAt: now}})
            result.usersWarned++
        } catch (error) {
            logger.error("SyncCleanup.warnUser", `User ${user._id!.toHexString()}`, error)
            result.failed++
        }
    }

    return result
}
