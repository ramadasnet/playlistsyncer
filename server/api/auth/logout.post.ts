// End the current authenticated session.
import {destroySession} from "../../domain/auth/session"

export default defineEventHandler(async (event) => {
    await destroySession(event)
    return {ok: true}
})
