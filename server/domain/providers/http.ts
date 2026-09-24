// Perform authenticated requests against provider APIs and normalize failures.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {getProviderRateLimiter, maxQueueWaitMs} from "./rate-limit"
import {getAccessToken} from "./token"

const youtubeRateLimitReasons = new Set(["rateLimitExceeded", "userRateLimitExceeded"])

// YouTube reports short-term rate limits as 403s, unlike daily quota exhaustion which cannot be retried.
async function isYoutubeRateLimit(response: Response): Promise<boolean> {
    if (response.status !== 403) {
        return false
    }
    const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as {error?: {errors?: {reason?: string}[]}} | undefined
    return Boolean(body?.error?.errors?.some((error) => error.reason && youtubeRateLimitReasons.has(error.reason)))
}

async function authorizedFetch(account: ProviderAccountDocument, url: string, init: RequestInit, forceRefresh = false): Promise<Response> {
    const limiter = getProviderRateLimiter(account.provider)
    const headers = new Headers(init.headers)
    // SoundCloud documents the OAuth scheme. The other providers use Bearer.
    const accessToken = await getAccessToken(account, {force: forceRefresh})
    headers.set("Authorization", account.provider === "soundcloud" ? `OAuth ${accessToken}` : `Bearer ${accessToken}`)
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json")
    }
    return fetchWithRetry(
        url,
        {...init, headers},
        {
            label: "Provider.request",
            // Requests queue behind a shared per-provider limiter for up to its maximum cooldown.
            maxRetries: 5,
            maxRetryAfterMs: maxQueueWaitMs,
            isRateLimited: account.provider === "youtube" ? isYoutubeRateLimit : undefined,
            beforeAttempt: (signal) => limiter.acquire(signal),
            onRateLimited: (retryAfterMs) => limiter.onRateLimited(retryAfterMs)
        }
    )
}

// Add the current provider token, parse successful responses, and map errors.
export async function providerFetch<T>(account: ProviderAccountDocument, url: string, init: RequestInit = {}): Promise<T> {
    let response = await authorizedFetch(account, url, init)
    if (response.status === 401) {
        response = await authorizedFetch(account, url, init, true)
    }
    if (!response.ok) {
        const requestUrl = new URL(url)
        const logParts = [account.provider, init.method || "GET", requestUrl.pathname, `Status ${response.status}`, `Provider account ${account.externalAccountId}`]
        // Exhausted YouTube rate limit 403s are still rate limits, not upstream failures.
        const rateLimited = response.status === 429 || (account.provider === "youtube" && (await isYoutubeRateLimit(response)))
        if (rateLimited) {
            logger.warn("Provider.request", ...logParts, "Rate limited")
        } else {
            logger.error("Provider.request", ...logParts)
        }
        throw createError({
            statusCode: rateLimited ? 429 : 502,
            statusMessage: `${account.provider} API request failed (${response.status})`
        })
    }
    if (response.status === 204) {
        return undefined as T
    }
    // Some successful deletes, including SoundCloud playlist removal, return an empty body.
    const payload = await response.text()
    if (!payload.trim()) {
        return undefined as T
    }
    return JSON.parse(payload) as T
}
