// Resolve encrypted provider tokens and refresh them when they are near expiry.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {decryptSecret, encryptSecret} from "../../utils/secrets"
import {getOAuthProvider} from "../auth/providers"

// Return a usable access token, persisting refreshed credentials when needed.
export async function getAccessToken(account: ProviderAccountDocument): Promise<string> {
    if (!account.tokenExpiresAt || account.tokenExpiresAt.getTime() > Date.now() + 60_000) {
        return decryptSecret(account.accessToken)
    }
    if (!account.refreshToken) {
        logger.warn("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`, "Refresh token is unavailable")
        throw createError({statusCode: 409, statusMessage: `${account.provider} must be reconnected`})
    }
    logger.info("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`)
    const definition = getOAuthProvider(account.provider)
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: await decryptSecret(account.refreshToken)
    })
    const headers = new Headers({"Content-Type": "application/x-www-form-urlencoded"})
    if (definition.tokenAuth === "basic") {
        headers.set("Authorization", `Basic ${Buffer.from(`${definition.clientId}:${definition.clientSecret}`).toString("base64")}`)
    } else {
        body.set("client_id", definition.clientId)
        body.set("client_secret", definition.clientSecret)
    }
    const response = await fetch(definition.tokenUrl, {method: "POST", headers, body})
    if (!response.ok) {
        logger.error("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`, `Status ${response.status}`)
        throw createError({
            statusCode: 409,
            statusMessage: `${account.provider} token refresh failed; reconnect the account`
        })
    }
    const token = (await response.json()) as {access_token: string; refresh_token?: string; expires_in?: number}
    const encryptedAccessToken = await encryptSecret(token.access_token)
    const db = await collections()
    await db.providerAccounts.updateOne(
        {_id: account._id},
        {
            $set: {
                accessToken: encryptedAccessToken,
                ...(token.refresh_token ? {refreshToken: await encryptSecret(token.refresh_token)} : {}),
                tokenExpiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
                updatedAt: new Date()
            }
        }
    )
    account.accessToken = encryptedAccessToken
    logger.info("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`, "Token refreshed")
    return token.access_token
}
