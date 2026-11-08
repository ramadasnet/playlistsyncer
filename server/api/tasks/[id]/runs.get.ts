// Return a task's recent run history.
import {requireUser} from "../../../domain/auth/session"
import {loadSyncTaskDetail} from "../../../domain/sync/task-detail"
import {parseObjectId} from "../../../utils/object-id"

// Load owned runs and their track details.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const detail = await loadSyncTaskDetail(user._id!, taskId)
    if (!detail) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    return {runs: detail.runs}
})
