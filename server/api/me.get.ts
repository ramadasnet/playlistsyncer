// Return the current session user and synchronize entitlement locks.
import {getCurrentUser, serializeUser} from "../domain/auth/session"
import {applyTaskEntitlement} from "../domain/billing/task-entitlement"

// Allow anonymous callers while serializing authenticated users consistently.
export default defineEventHandler(async (event) => {
    const user = await getCurrentUser(event)
    if (user) {
        await applyTaskEntitlement(user)
    }
    return {user: user ? serializeUser(user) : null}
})
