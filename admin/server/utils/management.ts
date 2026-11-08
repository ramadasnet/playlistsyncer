import {createError, getQuery, type H3Event} from "h3"
import {ObjectId, type Filter} from "mongodb"
import {z} from "zod"
import {collections} from "../../../server/data/collections"
import {deleteUserAccount} from "../../../server/domain/accounts"
import type {MailMetrics} from "../../../server/domain/mail/send"
import {assertSyncTaskIdle, idleLeaseFilter} from "../../../server/domain/sync/task-activity"
import {playlistWriteKey, storedPlaylistWriteKeys, writtenPlaylistRefs} from "../../../server/domain/sync/playlist-writes"
import {getDatabase} from "../../../server/utils/database"
import {evaluateWeeklySyncSummaryPreference} from "../../../server/domain/mail/weekly-sync-summary"
import {maxDisplayNameLength, normalizeDisplayName} from "../../../shared/display-name"
import {providers, type SyncTaskDocument, type UserDocument} from "../../../shared/types/domain"

/** Reject malformed identifiers before they reach the database. */
export function adminObjectId(value: string) {
    if (!/^[a-f\d]{24}$/i.test(value)) throw createError({statusCode: 400, statusMessage: "Invalid identifier"})
    return new ObjectId(value)
}

/** Whitelist account fields so verification secrets never leave the server. */
export function userView(user: UserDocument) {
    return {
        id: user._id!.toHexString(),
        displayName: user.displayName,
        email: user.email || "",
        pendingEmail: user.tempEmail || "",
        weeklySyncSummaryEnabled: Boolean(user.weeklySyncSummaryEnabled),
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        updatedAt: user.updatedAt
    }
}

/** Expose task configuration and activity, never provider credentials or lease identifiers. */
export function taskView(task: SyncTaskDocument) {
    return {
        id: task._id!.toHexString(),
        userId: task.userId.toHexString(),
        mode: task.mode,
        direction: task.direction,
        status: task.status,
        pauseReason: task.pauseReason,
        source: task.source.name,
        destination: task.destination.name,
        sourceAccountId: task.source.providerAccountId.toHexString(),
        destinationAccountId: task.destination.providerAccountId.toHexString(),
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastSuccessAt: task.lastSuccessAt,
        lastError: task.lastError,
        consecutiveFailures: task.consecutiveFailures || 0,
        busy: Boolean(task.leaseExpiresAt && task.leaseExpiresAt > new Date()),
        createdAt: task.createdAt
    }
}

const listSchema = z.object({page: z.coerce.number().int().min(1).max(100000).default(1), search: z.string().trim().max(100).default(""), status: z.string().default(""), userId: z.string().default(""), provider: z.enum(providers).optional()})
const pageSize = 25

/** Search users with bounded pagination and escaped literal search terms. */
export async function listUsers(event: H3Event) {
    const query = listSchema.parse(getQuery(event))
    const db = await collections()
    const filter: Filter<UserDocument> = {}
    if (query.search) {
        const expression = {$regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i"}
        filter.$or = [{email: expression}, {displayName: expression}]
    }
    if (query.provider) filter._id = {$in: await db.providerAccounts.distinct("userId", {provider: query.provider})}
    const [users, total] = await Promise.all([
        db.users
            .find(filter)
            .sort({createdAt: -1, _id: -1})
            .skip((query.page - 1) * pageSize)
            .limit(pageSize)
            .toArray(),
        db.users.countDocuments(filter)
    ])
    const ids = users.map((user) => user._id!)
    const accounts = await db.providerAccounts.find({userId: {$in: ids}}, {projection: {userId: 1, provider: 1}}).toArray()
    return {items: users.map((user) => ({...userView(user), providers: [...new Set(accounts.filter((account) => account.userId.equals(user._id!)).map((account) => account.provider))]})), total, page: query.page, pageSize}
}

/** Return an account with its safe provider profiles. */
export async function getUser(id: string) {
    const db = await collections()
    const user = await db.users.findOne({_id: adminObjectId(id)})
    if (!user) throw createError({statusCode: 404, statusMessage: "User not found"})
    const accounts = await db.providerAccounts.find({userId: user._id!}, {projection: {_id: 1, provider: 1, displayName: 1, email: 1, connectedAt: 1}}).toArray()
    return {user: userView(user), accounts: accounts.map((account) => ({id: account._id!.toHexString(), provider: account.provider, displayName: account.displayName, email: account.email, connectedAt: account.connectedAt}))}
}

/** Keep a durable intent record before a privileged mutation starts. */
export async function audited<T>(event: H3Event, action: string, target: string, details: unknown, work: () => Promise<T>): Promise<T> {
    const database = await getDatabase()
    const audit = database.collection("adminAudit")
    const inserted = await audit.insertOne({actor: event.context.admin.email, action, target, details, status: "pending", createdAt: new Date()})
    try {
        const result = await work()
        await audit.updateOne({_id: inserted.insertedId}, {$set: {status: "succeeded", finishedAt: new Date()}})
        return result
    } catch (error) {
        await audit.updateOne({_id: inserted.insertedId}, {$set: {status: "failed", finishedAt: new Date()}})
        throw error
    }
}

const userUpdateSchema = z
    .object({
        displayName: z.string().transform(normalizeDisplayName).pipe(z.string().min(1).max(maxDisplayNameLength)),
        email: z
            .string()
            .trim()
            .toLowerCase()
            .pipe(z.union([z.literal(""), z.email()])),
        weeklySyncSummaryEnabled: z.boolean()
    })
    .strict()

/** Update user profile fields and notification preferences. */
export async function updateUser(event: H3Event, id: string, input: unknown) {
    const body = userUpdateSchema.parse(input)
    const db = await collections()
    const user = await db.users.findOne({_id: adminObjectId(id)})
    if (!user) throw createError({statusCode: 404, statusMessage: "User not found"})
    // Keep a missing confirmed email unset. An empty string would occupy the sparse unique index.
    const email = body.email || undefined
    if (!email && user.email) throw createError({statusCode: 400, statusMessage: "Confirmed email is required"})
    const preference = evaluateWeeklySyncSummaryPreference({email: email ?? user.email, enabled: body.weeklySyncSummaryEnabled})
    if (!preference.ok) throw createError({statusCode: preference.statusCode, statusMessage: preference.statusMessage})
    if (email && (await db.users.findOne({_id: {$ne: user._id!}, $or: [{email}, {tempEmail: email}]}))) throw createError({statusCode: 409, statusMessage: "Email is already used by another account"})
    const changes = {displayName: body.displayName, weeklySyncSummaryEnabled: body.weeklySyncSummaryEnabled, ...(email ? {email} : {})}
    const emailChanged = email !== undefined && email !== user.email
    return audited(event, "user.update", id, {before: {displayName: user.displayName, email: user.email, weeklySyncSummaryEnabled: user.weeklySyncSummaryEnabled}, after: changes}, async () => {
        await db.users.updateOne({_id: user._id}, {$set: {...changes, updatedAt: new Date()}, ...(emailChanged ? {$unset: {tempEmail: "", emailVerificationTokenHash: "", emailVerificationExpiresAt: "", emailConfirmationSentAt: ""}} : {})})
        if (emailChanged) await db.sessions.deleteMany({userId: user._id!})
        return getUser(id)
    })
}

/** Delete a user with all their data, unless a sync task is running. */
export async function deleteUser(event: H3Event, id: string) {
    const db = await collections()
    const user = await db.users.findOne({_id: adminObjectId(id)})
    if (!user) throw createError({statusCode: 404, statusMessage: "User not found"})
    return audited(event, "user.delete", id, {email: user.email, displayName: user.displayName}, async () => {
        await deleteUserAccount(user)
        return {ok: true}
    })
}

/** List task state with bounded results and owner/status filters. */
export async function listTasks(event: H3Event) {
    const query = listSchema.parse(getQuery(event))
    const db = await collections()
    const filter: Filter<SyncTaskDocument> = {}
    if (query.userId) filter.userId = adminObjectId(query.userId)
    if (query.status) filter.status = z.enum(["active", "paused", "needs_attention"]).parse(query.status)
    if (query.search) {
        if (/^[a-f\d]{24}$/i.test(query.search)) filter.$or = [{_id: new ObjectId(query.search)}, {userId: new ObjectId(query.search)}]
        else {
            const expression = {$regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i"}
            filter.$or = [{"source.name": expression}, {"destination.name": expression}]
        }
    }
    const [tasks, total] = await Promise.all([
        db.syncTasks
            .find(filter)
            .sort({createdAt: -1, _id: -1})
            .skip((query.page - 1) * pageSize)
            .limit(pageSize)
            .toArray(),
        db.syncTasks.countDocuments(filter)
    ])
    const users = await db.users.find({_id: {$in: tasks.map((task) => task.userId)}}, {projection: {_id: 1, email: 1, displayName: 1}}).toArray()
    return {items: tasks.map((task) => ({...taskView(task), owner: users.find((user) => user._id!.equals(task.userId))?.email || task.userId.toHexString()})), total, page: query.page, pageSize}
}

/** Return recent execution summaries without transferring track histories. */
export async function getTask(id: string) {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: adminObjectId(id)})
    if (!task) throw createError({statusCode: 404, statusMessage: "Task not found"})
    const runs = await db.syncRuns
        .find({taskId: task._id!}, {projection: {status: 1, startedAt: 1, finishedAt: 1, additions: 1, removals: 1, skipped: 1, conflicts: 1, error: 1}})
        .sort({startedAt: -1})
        .limit(10)
        .toArray()
    return {
        task: taskView(task),
        runs: runs.map((run) => ({
            id: run._id!.toHexString(),
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            additions: run.additions,
            removals: run.removals,
            skipped: run.skipped,
            conflicts: run.conflicts,
            error: run.error
        }))
    }
}

const taskUpdateSchema = z.object({status: z.enum(["active", "paused"]), direction: z.enum(["one-way", "two-way"]), nextRunAt: z.iso.datetime({offset: true}).transform((value) => new Date(value))}).strict()

/** Change scheduling only while idle; preserve playlist writer constraints and history. */
export async function updateTask(event: H3Event, id: string, input: unknown, cancel = false) {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: adminObjectId(id)})
    if (!task) throw createError({statusCode: 404, statusMessage: "Task not found"})
    await assertSyncTaskIdle(task)
    const body = cancel ? {status: "paused" as const, direction: task.direction, nextRunAt: task.nextRunAt} : taskUpdateSchema.parse(input)
    if (task.mode === "account" && body.direction !== "one-way") throw createError({statusCode: 409, statusMessage: "Full-account syncs must remain one-way"})
    const user = await db.users.findOne({_id: task.userId})
    if (!user) throw createError({statusCode: 404, statusMessage: "Task owner not found"})
    const tasks = await db.syncTasks.find({userId: user._id!}).toArray()
    const playlistWriteKeys = storedPlaylistWriteKeys({...task, direction: body.direction})
    if (body.direction !== task.direction && playlistWriteKeys) {
        const claimed = new Set(tasks.filter((other) => !other._id!.equals(task._id!)).flatMap((other) => writtenPlaylistRefs(other).map((ref) => playlistWriteKey(ref.providerAccountId, ref.playlistId))))
        if (playlistWriteKeys.some((key) => claimed.has(key))) throw createError({statusCode: 409, statusMessage: "Another task already writes to one of these playlists"})
    }
    return audited(event, cancel ? "task.cancel" : "task.update", id, {before: taskView(task), after: body}, async () => {
        const result = await db.syncTasks.updateOne(
            {_id: task._id!, ...idleLeaseFilter()},
            {$set: {...body, ...(playlistWriteKeys ? {playlistWriteKeys} : {}), ...(body.status === "paused" ? {pauseReason: "user" as const} : {}), updatedAt: new Date()}, ...(body.status === "active" ? {$unset: {pauseReason: ""}} : {})}
        )
        if (!result.matchedCount) throw createError({statusCode: 409, statusMessage: "Task is now running; retry when it finishes"})
        return getTask(id)
    })
}

/** Delete an idle task and its retained run history and snapshots. */
export async function deleteTask(event: H3Event, id: string) {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: adminObjectId(id)})
    if (!task) throw createError({statusCode: 404, statusMessage: "Task not found"})
    await assertSyncTaskIdle(task)
    return audited(event, "task.delete", id, {before: taskView(task)}, async () => {
        const result = await db.syncTasks.deleteOne({_id: task._id!, ...idleLeaseFilter()})
        if (!result.deletedCount) throw createError({statusCode: 409, statusMessage: "Task is now running; retry when it finishes"})
        await Promise.all([db.syncSnapshots.deleteMany({taskId: task._id!}), db.syncRuns.deleteMany({taskId: task._id!})])
        return {ok: true}
    })
}

/** Count distinct tracked playlists, users per provider, and operational health at the database. */
export async function statistics() {
    const db = await collections()
    const database = await getDatabase()
    const since = new Date(Date.now() - 86_400_000)
    const [users, tasks, activeTasks, attentionTasks, runningTasks, failedRuns, succeededRuns, partialRuns, newUsers, summaryUsers, providerUsers, playlists, mail, lastAudit] = await Promise.all([
        db.users.countDocuments(),
        db.syncTasks.countDocuments(),
        db.syncTasks.countDocuments({status: "active"}),
        db.syncTasks.countDocuments({status: "needs_attention"}),
        db.syncTasks.countDocuments({leaseExpiresAt: {$gt: new Date()}}),
        db.syncRuns.countDocuments({status: "failed", startedAt: {$gte: since}}),
        db.syncRuns.countDocuments({status: "succeeded", startedAt: {$gte: since}}),
        db.syncRuns.countDocuments({status: "partial", startedAt: {$gte: since}}),
        db.users.countDocuments({createdAt: {$gte: since}}),
        db.users.countDocuments({weeklySyncSummaryEnabled: true}),
        Promise.all(
            providers.map(async (provider) => {
                const counts = await db.providerAccounts.aggregate<{total: number}>([{$match: {provider}}, {$group: {_id: "$userId"}}, {$count: "total"}]).toArray()
                return {provider, users: counts[0]?.total || 0}
            })
        ),
        db.syncTasks
            .aggregate<{total: number}>([
                {
                    $project: {
                        refs: {
                            $cond: [
                                {$eq: ["$mode", "account"]},
                                {
                                    $reduce: {
                                        input: {$ifNull: ["$playlistMappings", []]},
                                        initialValue: [],
                                        in: {
                                            $concatArrays: [
                                                "$$value",
                                                [
                                                    {account: "$source.providerAccountId", playlist: "$$this.sourcePlaylistId"},
                                                    {account: "$destination.providerAccountId", playlist: "$$this.destinationPlaylistId"}
                                                ]
                                            ]
                                        }
                                    }
                                },
                                [
                                    {account: "$source.providerAccountId", playlist: "$source.playlistId"},
                                    {account: "$destination.providerAccountId", playlist: "$destination.playlistId"}
                                ]
                            ]
                        }
                    }
                },
                {$unwind: "$refs"},
                {$group: {_id: "$refs"}},
                {$count: "total"}
            ])
            .toArray(),
        database.collection<MailMetrics>("operationalMetrics").findOne({_id: "email"}, {projection: {_id: 0}}),
        database
            .collection("adminAudit")
            .find({}, {projection: {details: 0}})
            .sort({createdAt: -1})
            .limit(12)
            .toArray()
    ])
    return {
        users,
        tasks,
        activeTasks,
        pausedTasks: tasks - activeTasks - attentionTasks,
        attentionTasks,
        runningTasks,
        failedRuns24h: failedRuns,
        succeededRuns24h: succeededRuns,
        partialRuns24h: partialRuns,
        newUsers24h: newUsers,
        summaryUsers,
        providerUsers,
        trackedPlaylists: playlists[0]?.total || 0,
        email: mail ? {accepted: mail.accepted || 0, failed: mail.failed || 0, since: mail.startedAt} : null,
        audit: lastAudit.map((entry) => ({id: entry._id.toHexString(), actor: entry.actor, action: entry.action, target: entry.target, status: entry.status, createdAt: entry.createdAt})),
        measuredAt: new Date()
    }
}
