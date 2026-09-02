import {collections} from "../../data/collections"
import {runSyncTask} from "../../domain/sync/engine"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"

export default defineEventHandler(async (event) => {
    requireScheduler(event)
    const db = await collections()
    const dueTasks = await db.syncTasks
        .find({status: {$in: ["active", "needs_attention"]}, nextRunAt: {$lte: new Date()}})
        .sort({nextRunAt: 1})
        .limit(10)
        .toArray()
    logger.info("Jobs.syncDue", `Due tasks ${dueTasks.length}`)
    const results = []
    for (const task of dueTasks) {
        try {
            results.push({id: task._id!.toHexString(), ok: true, result: await runSyncTask(task._id!, "scheduled")})
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
