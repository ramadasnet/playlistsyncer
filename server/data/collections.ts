import type {Collection} from "mongodb"
import type {
    OAuthTransactionDocument,
    ProviderAccountDocument,
    SessionDocument,
    SyncRunDocument,
    SyncSnapshotDocument,
    SyncTaskDocument,
    UserDocument,
    WebhookEventDocument
} from "~~/shared/types/domain"
import {getDatabase} from "../utils/database"

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

export async function ensureIndexes(): Promise<void> {
    const db = await collections()
    await Promise.all([
        db.users.createIndex({email: 1}, {unique: true}),
        db.providerAccounts.createIndex({provider: 1, externalAccountId: 1}, {unique: true}),
        db.providerAccounts.createIndex({userId: 1, provider: 1}),
        db.sessions.createIndex({tokenHash: 1}, {unique: true}),
        db.sessions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.oauthTransactions.createIndex({stateHash: 1}, {unique: true}),
        db.oauthTransactions.createIndex({expiresAt: 1}, {expireAfterSeconds: 0}),
        db.syncTasks.createIndex({userId: 1, status: 1}),
        db.syncTasks.createIndex({nextRunAt: 1, status: 1}),
        db.syncSnapshots.createIndex({taskId: 1}, {unique: true}),
        db.syncRuns.createIndex({taskId: 1, startedAt: -1}),
        db.syncRuns.createIndex({startedAt: 1}, {expireAfterSeconds: 60 * 60 * 24 * 180}),
        db.webhookEvents.createIndex({eventId: 1}, {unique: true}),
        db.webhookEvents.createIndex({processedAt: 1}, {expireAfterSeconds: 60 * 60 * 24 * 90})
    ])
}
