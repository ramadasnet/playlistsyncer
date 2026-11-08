// Exchange a one-time authorization code and PKCE verifier for the extension's bearer token.
import {z} from "zod"
import type {ExtensionTokenResponse} from "~~/shared/types/extension"
import {exchangeExtensionAuthorizationCode, requireExtensionEnabled} from "../../domain/extension/clients"

const tokenSchema = z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(16).max(200),
    code_verifier: z.string().min(43).max(128),
    redirect_uri: z.string().url().max(500),
    version: z.string().max(40).optional()
})

export default defineEventHandler(async (event): Promise<ExtensionTokenResponse> => {
    requireExtensionEnabled()
    const body = tokenSchema.safeParse(await readBody(event))
    if (!body.success) {
        throw createError({statusCode: 400, statusMessage: "invalid_request"})
    }
    const {token, user} = await exchangeExtensionAuthorizationCode({code: body.data.code, codeVerifier: body.data.code_verifier, redirectUri: body.data.redirect_uri, version: body.data.version})
    setResponseHeader(event, "Cache-Control", "no-store")
    return {access_token: token, token_type: "Bearer", user: {name: user.displayName, ...(user.email ? {email: user.email} : {})}}
})
