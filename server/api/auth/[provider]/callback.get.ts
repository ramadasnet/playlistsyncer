// Complete the provider OAuth callback and redirect to the application.
import {z} from "zod"
import {finishOAuth} from "../../../domain/auth/oauth"
import {getProviderParam} from "../../../utils/provider-param"

const callbackSchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1)
})

// Validate callback parameters before consuming the OAuth transaction.
export default defineEventHandler(async (event) => {
    const query = callbackSchema.parse(getQuery(event))
    const redirect = await finishOAuth(event, getProviderParam(event), query.code, query.state)
    return sendRedirect(event, redirect)
})
