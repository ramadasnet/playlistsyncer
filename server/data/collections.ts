// Provide typed MongoDB collections and create the indexes they require.
import type {Collection, IndexDescriptionInfo} from "mongodb"
import type {OAuthTransactionDocument, ProviderAccountDocument, SessionDocument, SyncRunDocument, SyncSnapshotDocument, SyncTaskDocument, UserDocument, WebhookEventDocument} from "~~/shared/types/domain"
import {getDatabase} from "../utils/database"

const accountSyncPairIndex = "userId_1_accountSyncPairKey_1"
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

// Replace the partial unique pair index with a sparse one. Firestore cannot build partial indexes.
async function ensureAccountSyncPairIndex(syncTasks: Collection<SyncTaskDocument>): Promise<void> {
    const existing = (await listIndexes(syncTasks)).find((index) => index.name === accountSyncPairIndex)
    if (existing?.partialFilterExpression || !existing) {
        await syncTasks.updateMany({accountSyncPairKey: {$type: "null"}}, {$unset: {accountSyncPairKey: ""}})
    }
    if (existing?.partialFilterExpression) {
        await syncTasks.dropIndex(accountSyncPairIndex)
    }
    try {
        await syncTasks.createIndex({userId: 1, accountSyncPairKey: 1}, {name: accountSyncPairIndex, unique: true, sparse: true})
    } catch (error) {
        const alreadyExists = Boolean(error && typeof error === "object" && "code" in error && error.code === 68)
        if (!alreadyExists) throw error
    }
}
