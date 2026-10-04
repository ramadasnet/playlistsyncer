// Provide typed MongoDB collections and create the indexes they require.
import type {Collection, IndexDescriptionInfo} from "mongodb"
import type {OAuthTransactionDocument, ProviderAccountDocument, SessionDocument, SyncRunDocument, SyncSnapshotDocument, SyncTaskDocument, UserDocument, WebhookEventDocument} from "~~/shared/types/domain"
import {getDatabase} from "../utils/database"

const accountSyncPairIndex = "accountSyncPairKey_1"
const legacyAccountSyncPairIndex = "userId_1_accountSyncPairKey_1"
const snapshotTaskIndex = "taskId_1"
const snapshotBatchIndex = "taskId_1_batch_1"

const collectionNames = {
    users: "users",
    providerAccounts: "providerAccounts",
    sessions: "sessions",
    oauthTransactions: "oauthTransactions",
    syncTasks: "syncTasks",
    syncSnapshots: "syncSnapshots",
    syncRuns: "syncRuns",
    webhookEvents: "webhookEvents"
} as const

// Return the application's typed collection handles.
export async function collections(): Promise<{
    users: Collection<UserDocument>
    providerAccounts: Collection<ProviderAccountDocument>
    sessions: Collection<SessionDocument>
    oauthTransactions: Collection<OAuthTransactionDocument>
    syncTasks: Collection<SyncTaskDocument>
    syncSnapshots: Collection<SyncSnapshotDocument>
    syncRuns: Collection<SyncRunDocument>
    webhookEvents: Collection<WebhookEventDocument>
}> {
    const database = await getDatabase()
    return {
        users: database.collection<UserDocument>(collectionNames.users),
        providerAccounts: database.collection<ProviderAccountDocument>(collectionNames.providerAccounts),
        sessions: database.collection<SessionDocument>(collectionNames.sessions),
        oauthTransactions: database.collection<OAuthTransactionDocument>(collectionNames.oauthTransactions),
        syncTasks: database.collection<SyncTaskDocument>(collectionNames.syncTasks),
        syncSnapshots: database.collection<SyncSnapshotDocument>(collectionNames.syncSnapshots),
        syncRuns: database.collection<SyncRunDocument>(collectionNames.syncRuns),
        webhookEvents: database.collection<WebhookEventDocument>(collectionNames.webhookEvents)
    }
}

// Ensure uniqueness, lookup, TTL, and scheduling indexes exist.
export async function ensureIndexes(): Promise<void> {
    const db = await collections()
    await ensureAccountSyncPairIndex(db.syncTasks)
    await ensureSnapshotIndex(db.syncSnapshots)
    await Promise.all([
        db.users.createIndex({email: 1}, {unique: true, sparse: true}),
        db.users.createIndex({tempEmail: 1}, {unique: true, sparse: true}),
        db.users.createIndex({emailVerificationTokenHash: 1}, {sparse: true}),
        db.users.createIndex({weeklySyncSummaryEnabled: 1, weeklySyncSummarySentAt: 1}),
        db.providerAccounts.createIndex({provider: 1, externalAccountId: 1}, {unique: true}),
        db.providerAccounts.createIndex({userId: 1, provider: 1}),
        db.sessions.createIndex({tokenHash: 1}, {unique: true}),
        db.sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.oauthTransactions.createIndex({stateHash: 1}, {unique: true}),
        db.oauthTransactions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.syncTasks.createIndex({userId: 1, status: 1}),
        db.syncTasks.createIndex({nextRunAt: 1, status: 1}),
        db.syncRuns.createIndex({taskId: 1, startedAt: -1}),
        db.syncRuns.createIndex({startedAt: 1}, {expireAfterSeconds: 60 * 60 * 24 * 180}),
        db.webhookEvents.createIndex({eventId: 1}, {unique: true}),
        db.webhookEvents.createIndex({processedAt: 1}, {expireAfterSeconds: 60 * 60 * 24 * 90})
    ])
}

// Read indexes, treating a missing collection as having none yet.
async function listIndexes(collection: Collection): Promise<IndexDescriptionInfo[]> {
    try {
        return await collection.listIndexes().toArray()
    } catch (error) {
        const missing = Boolean(error && typeof error === "object" && "code" in error && error.code === 26)
        if (missing) return []
        throw error
    }
}

// Allow one playlist snapshot per task, and several numbered batches for a full sync.
async function ensureSnapshotIndex(syncSnapshots: Collection<SyncSnapshotDocument>): Promise<void> {
    const indexes = await listIndexes(syncSnapshots)
    if (indexes.some((index) => index.name === snapshotTaskIndex)) {
        await syncSnapshots.dropIndex(snapshotTaskIndex)
    }
    try {
        await syncSnapshots.createIndex({taskId: 1, batch: 1}, {name: snapshotBatchIndex, unique: true})
    } catch (error) {
        const alreadyExists = Boolean(error && typeof error === "object" && "code" in error && error.code === 68)
        if (!alreadyExists) throw error
    }
}

// One full sync per user and provider pair. Playlist tasks omit the key, so a single-field sparse index skips them.
// A compound sparse index would still include those tasks because every task has userId. Firestore cannot build partial indexes.
async function ensureAccountSyncPairIndex(syncTasks: Collection<SyncTaskDocument>): Promise<void> {
    const indexes = await listIndexes(syncTasks)
    const legacy = indexes.find((index) => index.name === legacyAccountSyncPairIndex)
    const ready = indexes.some((index) => index.name === accountSyncPairIndex && index.unique && index.sparse)
    if (legacy || !ready) {
        await syncTasks.updateMany({accountSyncPairKey: {$type: "null"}}, {$unset: {accountSyncPairKey: ""}})
        await prefixAccountSyncPairKeys(syncTasks)
    }
    if (legacy) {
        await dropIndexIfPresent(syncTasks, legacyAccountSyncPairIndex)
    }
    try {
        await syncTasks.createIndex({accountSyncPairKey: 1}, {name: accountSyncPairIndex, unique: true, sparse: true})
    } catch (error) {
        const alreadyExists = mongoErrorCode(error) === 68
        if (!alreadyExists) throw error
    }
}

// Prefix keys stored before the user id was part of the value, so two users can share a provider pair.
async function prefixAccountSyncPairKeys(syncTasks: Collection<SyncTaskDocument>): Promise<void> {
    const tasks = await syncTasks.find({accountSyncPairKey: {$type: "string"}}, {projection: {userId: 1, accountSyncPairKey: 1}}).toArray()
    for (const task of tasks) {
        const key = task.accountSyncPairKey
        const prefix = `${task.userId.toHexString()}:`
        if (!key || key.startsWith(prefix)) continue
        await syncTasks.updateOne({_id: task._id}, {$set: {accountSyncPairKey: `${prefix}${key}`}})
    }
}

// Drop an index that another startup may already have removed.
async function dropIndexIfPresent(collection: Collection, name: string): Promise<void> {
    try {
        await collection.dropIndex(name)
    } catch (error) {
        const gone = mongoErrorCode(error) === 27
        if (!gone) throw error
    }
}

// Read a MongoDB server error code when the driver attached one.
function mongoErrorCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "number") return undefined
    return error.code
}
