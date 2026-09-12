import {getCurrentUser, serializeUser} from "../domain/auth/session"
import {applyTaskEntitlement} from "../domain/billing/task-entitlement"

export default defineEventHandler(async (event) => {
    const user = await getCurrentUser(event)
    if (user) {
        await applyTaskEntitlement(user)
    }
    return {user: user ? serializeUser(user) : null}
})
