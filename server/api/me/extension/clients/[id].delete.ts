// Unlink one browser extension from the signed-in user.
import {requireUser} from "../../../../domain/auth/session"
import {revokeExtensionClient} from "../../../../domain/extension/clients"
import {parseObjectId} from "../../../../utils/object-id"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    if (!(await revokeExtensionClient(user._id!, parseObjectId(getRouterParam(event, "id"), "browser id")))) {
        throw createError({statusCode: 404, statusMessage: "Linked browser not found"})
    }
    return {ok: true}
})
