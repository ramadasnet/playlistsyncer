// Provide typed MongoDB collections and create the indexes they require.
import type {Collection} from "mongodb"
import type {OAuthTransactionDocument, ProviderAccountDocument, SearchMissDocument, SessionDocument, SyncRunDocument, SyncSnapshotDocument, SyncTaskDocument, UserDocument, WebhookEventDocument} from "~~/shared/types/domain"
import {getDatabase} from "../utils/database"
import logger from "../utils/logger"
import {isTtlJobPrivilegeError} from "../utils/mongodb"

// TTL indexes remove sync runs and webhook events after these ages. sync-cleanup uses the same limits.
export const syncRunRetentionSeconds = 60 * 60 * 24 * 180
export const webhookEventRetentionSeconds = 60 * 60 * 24 * 90

const collectionNames = {
    users: "users",
    providerAccounts: "providerAccounts",
    sessions: "sessions",
    oauthTransactions: "oauthTransactions",
    syncTasks: "syncTasks",
    syncSnapshots: "syncSnapshots",
    syncRuns: "syncRuns",
    searchMisses: "searchMisses",
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
    searchMisses: Collection<SearchMissDocument>
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
        searchMisses: database.collection<SearchMissDocument>(collectionNames.searchMisses),
        webhookEvents: database.collection<WebhookEventDocument>(collectionNames.webhookEvents)
    }
}

// Ensure uniqueness, lookup, TTL, and scheduling indexes exist.
export async function ensureIndexes(): Promise<void> {
    const db = await collections()
    await Promise.all([
        db.users.createIndex({email: 1}, {unique: true, sparse: true}),
        db.users.createIndex({tempEmail: 1}, {unique: true, sparse: true}),
        db.users.createIndex({emailVerificationTokenHash: 1}, {sparse: true}),
        db.users.createIndex({weeklySyncSummaryEnabled: 1, weeklySyncSummarySentAt: 1}),
        db.users.createIndex({lastLoginAt: 1}),
        db.providerAccounts.createIndex({provider: 1, externalAccountId: 1}, {unique: true}),
        db.providerAccounts.createIndex({userId: 1, provider: 1}),
        db.sessions.createIndex({tokenHash: 1}, {unique: true}),
        db.oauthTransactions.createIndex({stateHash: 1}, {unique: true}),
        db.syncTasks.createIndex({userId: 1, status: 1}),
        db.syncTasks.createIndex({nextRunAt: 1, status: 1}),
        // One full sync per user and provider pair. Playlist tasks omit the key, so a single-field sparse index skips them.
        // A compound sparse index would still include those tasks because every task has userId. Firestore cannot build partial indexes.
        db.syncTasks.createIndex({accountSyncPairKey: 1}, {unique: true, sparse: true}),
        // One writer per playlist for newly created playlist-pair tasks. A single-field sparse index skips full syncs and older tasks.
        db.syncTasks.createIndex({playlistWriteKeys: 1}, {unique: true, sparse: true}),
        // One playlist snapshot per task, and several numbered batches for a full sync.
        db.syncSnapshots.createIndex({taskId: 1, batch: 1}, {unique: true}),
        db.syncRuns.createIndex({taskId: 1, startedAt: -1}),
        db.searchMisses.createIndex({providerAccountId: 1, key: 1}, {unique: true}),
        db.webhookEvents.createIndex({eventId: 1}, {unique: true})
    ])
    // expireAfterSeconds: 0 deletes a document when its indexed date is reached.
    await ensureTtlIndexes([
        db.sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.oauthTransactions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.searchMisses.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.syncRuns.createIndex({startedAt: 1}, {expireAfterSeconds: syncRunRetentionSeconds}),
        db.webhookEvents.createIndex({processedAt: 1}, {expireAfterSeconds: webhookEventRetentionSeconds})
    ])
}

// Continue startup when every TTL index failed because the database user cannot create jobs.
export async function ensureTtlIndexes(creates: Array<Promise<unknown>>): Promise<void> {
    const settled = await Promise.allSettled(creates)
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    if (!rejected.length) return
    const unexpected = rejected.find((result) => !isTtlJobPrivilegeError(result.reason))
    if (unexpected) throw unexpected.reason
    logger.warn("Database.indexes", "TTL indexes were not created because the database user lacks the CREATE JOB privilege. sync-cleanup deletes expired documents instead.")
}
