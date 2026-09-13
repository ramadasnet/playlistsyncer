// Run one synchronization task from an authenticated scheduler request.
import {runSyncTask} from "../../../domain/sync/engine"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"
import {requireScheduler} from "../../../utils/scheduler-auth"

// Validate the task identifier before handing it to the sync engine.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    logger.info("Jobs.syncTask", `Task ${taskId.toHexString()}`)
    return runSyncTask(taskId, "scheduled")
})
