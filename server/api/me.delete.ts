// Delete the signed-in user's account and all of its data, then end the session.
import {deleteUserAccount} from "../domain/accounts"
import {destroySession, requireUser} from "../domain/auth/session"

export default defineEventHandler(async (event) => {
    await deleteUserAccount(await requireUser(event))
    await destroySession(event)
    return {ok: true}
})
