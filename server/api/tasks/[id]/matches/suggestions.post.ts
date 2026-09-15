// Return similar catalog tracks for an unmatched song from a sync run.
import {z} from "zod"
import {requireUser} from "../../../../domain/auth/session"
import {suggestMatchesForUnmatched} from "../../../../domain/sync/manual-match"
import {parseObjectId} from "../../../../utils/object-id"

const suggestionSchema = z.object({
    runId: z.string().min(1).optional(),
    playlistId: z.string().min(1),
    providerTrackId: z.string().min(1),
    providerItemId: z.string().min(1).optional()
})

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const taskId = parseObjectId(getRouterParam(event, "id"), "task id")
    const body = suggestionSchema.parse(await readBody(event))
    return suggestMatchesForUnmatched(user._id!, taskId, body)
})
