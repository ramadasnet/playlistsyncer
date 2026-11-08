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
