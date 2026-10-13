// Process a bounded batch of scheduler-due synchronization tasks.
import {defineEventHandler} from "h3"
import type {SyncTaskDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {beginSyncTask, completeSyncTask, failInterruptedRuns} from "../../domain/sync/engine"
import {idleLeaseFilter} from "../../domain/sync/task-activity"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"
import {isShuttingDown, startTrackedSyncRun} from "../../utils/shutdown"

export const syncDueBatchSize = 10

// Round-robin across users, each user's tasks in due order, so one user's tasks do not fill a batch.
export function interleaveByUser(tasks: SyncTaskDocument[]): SyncTaskDocument[] {
    const queues = new Map<string, SyncTaskDocument[]>()
    for (const task of tasks) {
        const key = task.userId.toHexString()
        queues.set(key, [...(queues.get(key) || []), task])
    }
    const result: SyncTaskDocument[] = []
    for (let round = 0; result.length < tasks.length; round++) {
        for (const queue of queues.values()) {
            if (queue[round]) {
                result.push(queue[round]!)
            }
        }
    }
    return result
}

/**
 * Runs due synchronization tasks, isolating a failure to the task that caused it.
 * @param limit Maximum tasks to start on this call.
 */
export async function runSyncDue(limit = syncDueBatchSize) {
    const db = await collections()
    await failInterruptedRuns()
    const now = new Date()
    // A task that is still running would only return 409 and take a slot from a due task.
    // Reading several batches ahead lets other users' due tasks get a turn.
    const candidates = await db.syncTasks
        .find({status: {$in: ["active", "needs_attention"]}, nextRunAt: {$lte: now}, ...idleLeaseFilter(now)})
        .sort({nextRunAt: 1})
        .limit(limit * 5)
        .toArray()
    const dueTasks = interleaveByUser(candidates).slice(0, limit)
    logger.info("Jobs.syncDue", `Due tasks ${dueTasks.length}`)
    const results = []
    for (const task of dueTasks) {
        // Tasks left over stay due and run on the next scheduler call.
        if (isShuttingDown()) {
            logger.warn("Jobs.syncDue", "Shutting down; not starting the remaining due tasks")
            break
        }
        try {
            const {finished} = await startTrackedSyncRun(() => beginSyncTask(task._id!, "scheduled"), completeSyncTask)
            results.push({id: task._id!.toHexString(), ok: true, result: await finished})
        } catch (error) {
            logger.error("Jobs.syncDue", `Task ${task._id!.toHexString()}`, error)
            results.push({
                id: task._id!.toHexString(),
                ok: false,
                error: error instanceof Error ? error.message : "Unknown error"
            })
        }
    }
    const failed = results.filter((result) => !result.ok).length
    const log = failed ? logger.warn : logger.info
    log("Jobs.syncDue", `Processed ${results.length}`, `Succeeded ${results.length - failed}`, `Failed ${failed}`)
    return {processed: results.length, results}
}

// Require scheduler authentication, then run the default batch.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    return runSyncDue()
})
