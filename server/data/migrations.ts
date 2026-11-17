// Explicit database maintenance; each migration must be safe to retry after a partial failure.
import type {Db} from "mongodb"
import {syncIntervalMs} from "../../shared/sync-cadence"
import {getServerConfig} from "../utils/config"
import logger from "../utils/logger"

const migrations = [
    {
        id: "remove-paid-subscriptions",
        async run(database: Db) {
            const now = new Date()
            const tasks = database.collection("syncTasks")
            const resumed = await tasks.updateMany({pauseReason: "entitlement"}, {$set: {status: "active", nextRunAt: now, updatedAt: now}, $unset: {pauseReason: ""}})
            // Bring existing weekly schedules onto the shared cadence without postponing tasks already due.
            const nextRunAt = new Date(now.getTime() + syncIntervalMs(getServerConfig().syncIntervalMinutes))
            await tasks.updateMany({status: {$in: ["active", "needs_attention"]}, nextRunAt: {$gt: nextRunAt}}, {$set: {nextRunAt, updatedAt: now}})
            const users = await database.collection("users").updateMany(
                {},
                {
                    $unset: {
                        tier: "",
                        creemCustomerId: "",
                        creemSubscriptionId: "",
                        creemSubscriptionStatus: "",
                        creemSubscriptionUpdatedAt: "",
                        creemLastTransactionDate: "",
                        creemNextTransactionDate: "",
                        creemCurrentPeriodStartDate: "",
                        creemCurrentPeriodEndDate: "",
                        creemCanceledAt: ""
                    }
                }
            )
            if ((await database.listCollections({name: "webhookEvents"}, {nameOnly: true}).toArray()).length) {
                await database.collection("webhookEvents").drop()
            }
            logger.info("Database.migrate", `Unlocked tasks ${resumed.modifiedCount}`, `Cleaned users ${users.modifiedCount}`)
        }
    },
    {
        id: "backfill-spotify-client-id",
        async run(database: Db) {
            // Users from before the credential pool were all authorized under the primary app unless their account says otherwise.
            // Extension connections never authorized an OAuth app, so they must not count against an app's user limit.
            const primaryClientId = getServerConfig().spotifyCredentials[0]?.clientId
            const users = database.collection("users")
            const accounts = await database
                .collection("providerAccounts")
                .find({provider: "spotify", connection: {$ne: "extension"}}, {projection: {userId: 1, oauthClientId: 1}})
                .toArray()
            let updated = 0
            for (const account of accounts) {
                const clientId = account.oauthClientId || primaryClientId
                if (!clientId) continue
                // Token refreshes read the account's own app, so a legacy account must keep the app it was authorized under if the primary changes later.
                if (!account.oauthClientId) {
                    await database.collection("providerAccounts").updateOne({_id: account._id, oauthClientId: {$in: [null, ""]}}, {$set: {oauthClientId: clientId}})
                }
                const result = await users.updateOne({_id: account.userId, spotifyClientId: {$in: [null, ""]}}, {$set: {spotifyClientId: clientId}})
                updated += result.modifiedCount
            }
            logger.info("Database.migrate", `Spotify users ${accounts.length}`, `Assigned to an app ${updated}`)
        }
    }
]

// Record completion only after all writes succeed, so a failed migration can be retried.
export async function runMigrations(database: Db): Promise<void> {
    const completed = database.collection<{_id: string; completedAt: Date}>("migrations")
    for (const migration of migrations) {
        if (await completed.findOne({_id: migration.id})) continue
        logger.info("Database.migrate", `Starting ${migration.id}`)
        await migration.run(database)
        await completed.updateOne({_id: migration.id}, {$set: {completedAt: new Date()}}, {upsert: true})
        logger.info("Database.migrate", `Completed ${migration.id}`)
    }
}
