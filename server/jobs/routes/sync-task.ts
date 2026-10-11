// Run one synchronization task from an authenticated scheduler request.
import {defineEventHandler, getRouterParam} from "h3"
import {beginSyncTask, completeSyncTask} from "../../domain/sync/engine"
import logger from "../../utils/logger"
import {parseObjectId} from "../../utils/object-id"
import {requireScheduler} from "../../utils/scheduler-auth"
import {startTrackedSyncRun} from "../../utils/shutdown"

/**
 * Runs one synchronization task.
 * @param id Task identifier.
 */
export async function runSyncTask(id: string | undefined) {
    const taskId = parseObjectId(id, "task id")
    logger.info("Jobs.syncTask", `Task ${taskId.toHexString()}`)
    const {finished} = await startTrackedSyncRun(() => beginSyncTask(taskId, "scheduled"), completeSyncTask)
    return finished
}

// Validate the task identifier before handing it to the sync engine.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    return runSyncTask(getRouterParam(event, "id"))
})
