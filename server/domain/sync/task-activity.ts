// Reject user actions while a sync task is still running.
import type {SyncTaskDocument} from "~~/shared/types/domain"
import {isSyncInProgress, syncTaskBusyMessage} from "../../../shared/sync-task-activity"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"

// Match the task list: the latest run is running, or the first sync has not finished.
export async function assertSyncTaskIdle(task: SyncTaskDocument) {
    const db = await collections()
    const latest = task._id ? await db.syncRuns.find({taskId: task._id}).sort({startedAt: -1}).limit(1).next() : null
    if (!isSyncInProgress({status: task.status, lastRunAt: task.lastRunAt, latestRun: latest})) return
    logger.warn("Sync.taskBusy", `Task ${task._id?.toHexString() || ""}`, syncTaskBusyMessage)
    throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
}
