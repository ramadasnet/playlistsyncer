// Add a manually chosen catalog track and link it for later synchronizations.
import {z} from "zod"
import {requireUser} from "../../../../domain/auth/session"
import {applyManualMatch} from "../../../../domain/sync/manual-match"
import logger from "../../../../utils/logger"
import {parseObjectId} from "../../../../utils/object-id"
import {enforceProviderRequestLimit} from "../../../../utils/user-rate-limit"

const matchSchema = z.object({
    runId: z.string().min(1).optional(),
    playlistId: z.string().min(1),
    providerTrackId: z.string().min(1),
    providerItemId: z.string().min(1).optional(),
    candidateTrackId: z.string().min(1)
})

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const body = matchSchema.parse(await readBody(event))
    logger.info("Tasks.manualMatch", `Task ${taskId.toHexString()}`, `User ${user._id!.toHexString()}`)
    return applyManualMatch(user._id!, taskId, body)
})
