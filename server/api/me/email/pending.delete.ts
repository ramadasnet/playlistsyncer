// Cancel a pending email confirmation for the authenticated account.
import {cancelPendingEmail} from "../../../domain/auth/email"
import {requireUser, serializeUser} from "../../../domain/auth/session"

// Clear the pending address and return the refreshed session payload.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const updated = await cancelPendingEmail(user)
    return {user: serializeUser(updated)}
})
