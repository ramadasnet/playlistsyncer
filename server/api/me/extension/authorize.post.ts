// Approve or deny a browser extension link request from the signed-in user, and return the redirect back to the extension.
import {z} from "zod"
import {requireUser} from "../../../domain/auth/session"
import {createExtensionAuthorizationCode, isAllowedRedirectUri, requireExtensionEnabled} from "../../../domain/extension/clients"
import logger from "../../../utils/logger"

const authorizeSchema = z.object({
    redirectUri: z.string().url().max(500),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeChallengeMethod: z.literal("S256"),
    state: z.string().min(8).max(200),
    browser: z.enum(["chrome", "firefox"]),
    allow: z.boolean()
})

export default defineEventHandler(async (event) => {
    requireExtensionEnabled()
    const user = await requireUser(event)
    const body = authorizeSchema.parse(await readBody(event))
    if (!isAllowedRedirectUri(body.redirectUri)) {
        logger.warn("Extension.authorize", `User ${user._id!.toHexString()}`, "Redirect URI not allowed", body.redirectUri)
        throw createError({statusCode: 400, statusMessage: "This browser extension is not recognized"})
    }
    const redirect = new URL(body.redirectUri)
    redirect.searchParams.set("state", body.state)
    if (body.allow) {
        redirect.searchParams.set("code", await createExtensionAuthorizationCode({userId: user._id!, redirectUri: body.redirectUri, codeChallenge: body.codeChallenge, browser: body.browser}))
    } else {
        redirect.searchParams.set("error", "access_denied")
    }
    return {redirectUrl: redirect.toString()}
})
