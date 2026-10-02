// Return one sync task and the runs shown on its details page.
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {loadSyncTaskDetail} from "../../domain/sync/task-detail"
import {parseObjectId} from "../../utils/object-id"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const detail = await loadSyncTaskDetail(user._id!, taskId, resolveEntitlement(user).tier)
    if (!detail) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    return detail
})
