// Backfill provider-pair keys without discarding existing full-sync tasks.
import type {Collection} from "mongodb"
import {accountSyncProviderPairKey, type ProviderAccountDocument, type SyncTaskDocument} from "../../shared/types/domain"
import logger from "../utils/logger"

// Claim a key for each legacy provider pair; pause extra tasks for manual review.
export async function backfillAccountSyncPairKeys(tasks: Collection<SyncTaskDocument>, accounts: Collection<ProviderAccountDocument>): Promise<void> {
    const providers = new Map<string, ProviderAccountDocument["provider"]>()
    for await (const task of tasks.find({mode: "account", accountSyncPairKey: {$not: {$type: "string"}}, pauseReason: {$ne: "conflict"}}).sort({createdAt: 1, _id: 1})) {
        const ids = [task.source.providerAccountId, task.destination.providerAccountId]
        for (const id of ids) {
            if (!providers.has(id.toHexString())) {
                const account = await accounts.findOne({_id: id, userId: task.userId}, {projection: {provider: 1}})
                if (account) providers.set(id.toHexString(), account.provider)
            }
        }
        const source = providers.get(ids[0]!.toHexString())
        const destination = providers.get(ids[1]!.toHexString())
        if (!source || !destination) {
            logger.warn("Database.accountSyncMigration", `Task ${task._id!.toHexString()}`, "Provider account missing; leaving legacy task unchanged")
            continue
        }
        try {
            await tasks.updateOne({_id: task._id, accountSyncPairKey: {$not: {$type: "string"}}}, {$set: {accountSyncPairKey: accountSyncProviderPairKey(source, destination)}})
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error
            await tasks.updateOne({_id: task._id}, {$set: {status: "paused", pauseReason: "conflict", updatedAt: new Date()}, $unset: {leaseId: "", leaseExpiresAt: ""}})
            logger.warn("Database.accountSyncMigration", `Task ${task._id!.toHexString()}`, "Duplicate provider pair; paused legacy task for manual review")
        }
    }
}
