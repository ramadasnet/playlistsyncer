// Start email confirmation for the authenticated account.
import {z} from "zod"
import {requestEmailConfirmation} from "../../domain/auth/email"
import {requireUser, serializeUser} from "../../domain/auth/session"

const schema = z.object({
    email: z.email()
})

// Validate the requested address and return the refreshed session payload.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const body = schema.parse(await readBody(event))
    const result = await requestEmailConfirmation(user, body.email)
    const updated = await requireUser(event)
    return {
        user: serializeUser(updated),
        sent: result.sent,
        devConfirmationUrl: result.devConfirmationUrl
    }
})
