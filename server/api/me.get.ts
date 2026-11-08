// Return the current session user.
import {getCurrentUser, serializeUser} from "../domain/auth/session"

// Allow anonymous callers while serializing authenticated users consistently.
export default defineEventHandler(async (event) => {
    const user = await getCurrentUser(event)
    return {user: user ? serializeUser(user) : null}
})
