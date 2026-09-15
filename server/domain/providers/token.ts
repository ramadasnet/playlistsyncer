// Resolve encrypted provider tokens and refresh them when they are near expiry.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {decryptSecret, encryptSecret} from "../../utils/secrets"
import {getOAuthProvider} from "../auth/providers"

export const tokenRefreshSkewMs = 15 * 60 * 1000

const refreshInFlight = new Map<string, Promise<string>>()

// True when the access token is missing an expiry buffer long enough for an active session.
export function accessTokenNeedsRefresh(tokenExpiresAt: Date | undefined, now = Date.now()): boolean {
    return Boolean(tokenExpiresAt && tokenExpiresAt.getTime() <= now + tokenRefreshSkewMs)
}

async function refreshAccessToken(account: ProviderAccountDocument): Promise<string> {
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
    const encryptedRefreshToken = token.refresh_token ? await encryptSecret(token.refresh_token) : undefined
    const tokenExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined
    const db = await collections()
    await db.providerAccounts.updateOne(
        {_id: account._id},
        {
            $set: {
                accessToken: encryptedAccessToken,
                ...(encryptedRefreshToken ? {refreshToken: encryptedRefreshToken} : {}),
                tokenExpiresAt,
                updatedAt: new Date()
            }
        }
    )
    account.accessToken = encryptedAccessToken
    if (encryptedRefreshToken) {
        account.refreshToken = encryptedRefreshToken
    }
    account.tokenExpiresAt = tokenExpiresAt
    logger.info("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`, "Token refreshed")
    return token.access_token
}

// Return a usable access token, persisting refreshed credentials when needed.
export async function getAccessToken(account: ProviderAccountDocument, options?: {force?: boolean}): Promise<string> {
    if (!options?.force && !accessTokenNeedsRefresh(account.tokenExpiresAt)) {
        return decryptSecret(account.accessToken)
    }
    const accountId = account._id?.toHexString()
    if (accountId) {
        const inFlight = refreshInFlight.get(accountId)
        if (inFlight) {
            return inFlight
        }
    }
    const pending = refreshAccessToken(account).finally(() => {
        if (accountId) {
            refreshInFlight.delete(accountId)
        }
    })
    if (accountId) {
        refreshInFlight.set(accountId, pending)
    }
    return pending
}

// Refresh connected accounts that are close to expiry so a session starts with valid tokens.
export async function ensureFreshAccessTokens(accounts: ProviderAccountDocument[]): Promise<void> {
    await Promise.all(
        accounts.map(async (account) => {
            try {
                await getAccessToken(account)
            } catch (error) {
                logger.warn("Provider.refreshToken", account.provider, `Provider account ${account.externalAccountId}`, error)
            }
        })
    )
}
