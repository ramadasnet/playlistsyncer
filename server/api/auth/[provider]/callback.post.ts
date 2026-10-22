// Receive Sign in with Apple's form_post callback and continue it as a top-level GET.
import {z} from "zod"
import {saveOAuthDisplayNameHint} from "../../../domain/auth/oauth"
import logger from "../../../utils/logger"
import {getProviderParam} from "../../../utils/provider-param"

const formSchema = z.object({
    state: z.string().min(1).max(512),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(200).optional(),
    user: z.string().max(4096).optional()
})

const appleUserSchema = z.object({
    name: z.object({firstName: z.string().optional(), lastName: z.string().optional()}).optional()
})

// Read the name Apple sends as JSON on the first authorization only.
function postedName(user?: string): string {
    if (!user) {
        return ""
    }
    try {
        const name = appleUserSchema.parse(JSON.parse(user)).name
        return [name?.firstName, name?.lastName].filter(Boolean).join(" ")
    } catch {
        return ""
    }
}

export default defineEventHandler(async (event) => {
    if (getProviderParam(event) !== "apple") {
        throw createError({statusCode: 405, statusMessage: "Method not allowed"})
    }
    const form = formSchema.safeParse(await readBody(event))
    if (!form.success || !form.data.code) {
        logger.warn("OAuth.callback", "apple", form.success ? `Authorization ended: ${form.data.error || "no code"}` : "Invalid callback form")
        return sendRedirect(event, "/login", 303)
    }
    await saveOAuthDisplayNameHint("apple", form.data.state, postedName(form.data.user))
    // Browsers omit SameSite=Lax cookies on this cross-site POST, but send them with the top-level GET that follows.
    return sendRedirect(event, `/api/auth/apple/callback?${new URLSearchParams({code: form.data.code, state: form.data.state}).toString()}`, 303)
})
