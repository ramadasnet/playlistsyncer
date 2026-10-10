// Process a bounded batch of scheduler-due synchronization tasks.
import {defineEventHandler} from "h3"
import {collections} from "../../data/collections"
import {beginSyncTask, completeSyncTask, failInterruptedRuns} from "../../domain/sync/engine"
import {idleLeaseFilter} from "../../domain/sync/task-activity"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"
import {isShuttingDown, startTrackedSyncRun} from "../../utils/shutdown"

// Require scheduler authentication, isolate failures per task, and stop starting tasks once shutdown begins.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    const db = await collections()
    await failInterruptedRuns()
    const now = new Date()
    // A task that is still running would only return 409 and take a slot from a due task.
    const dueTasks = await db.syncTasks
        .find({status: {$in: ["active", "needs_attention"]}, nextRunAt: {$lte: now}, ...idleLeaseFilter(now)})
        .sort({nextRunAt: 1})
        .limit(10)
        .toArray()
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
})
