// Disconnect one of the user's provider accounts and delete its stored tokens.
import {disconnectProviderAccount} from "../../domain/accounts"
import {requireUser} from "../../domain/auth/session"
import {parseObjectId} from "../../utils/object-id"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    await disconnectProviderAccount(user._id!, parseObjectId(getRouterParam(event, "id"), "account id"))
    return {ok: true}
})
