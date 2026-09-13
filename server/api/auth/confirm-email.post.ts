// Confirm an email token and return the refreshed session user.
import {z} from "zod"
import {confirmEmail} from "../../domain/auth/email"
import {getCurrentUser, serializeUser} from "../../domain/auth/session"

const schema = z.object({
    token: z.string().min(1)
})

// Validate and consume the confirmation token.
export default defineEventHandler(async (event) => {
    const body = schema.parse(await readBody(event))
    await confirmEmail(body.token)
    const user = await getCurrentUser(event)
    return {ok: true, user: user ? serializeUser(user) : null}
})
