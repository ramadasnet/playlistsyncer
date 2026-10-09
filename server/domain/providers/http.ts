// Perform authenticated requests against provider APIs and normalize failures.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {getProviderRateLimiter, maxQueueWaitMs} from "./rate-limit"
import {getAccessToken} from "./token"

const youtubeRateLimitReasons = new Set(["rateLimitExceeded", "userRateLimitExceeded"])
const youtubeQuotaReasons = new Set(["quotaExceeded", "dailyLimitExceeded"])
const youtubeQuotaMessage = "The YouTube daily API quota is used up. The sync continues after it resets at midnight Pacific time."

// Read the reasons YouTube lists on a 403 error body.
async function youtubeErrorReasons(response: Response): Promise<string[]> {
    if (response.status !== 403) {
        return []
    }
    const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as {error?: {errors?: {reason?: string}[]}} | undefined
    return (body?.error?.errors || []).flatMap((error) => (error.reason ? [error.reason] : []))
}

// YouTube reports short-term rate limits as 403s, unlike daily quota exhaustion which cannot be retried.
async function isYoutubeRateLimit(response: Response): Promise<boolean> {
    return (await youtubeErrorReasons(response)).some((reason) => youtubeRateLimitReasons.has(reason))
}

// A provider call failed because the YouTube daily quota is used up.
export function isQuotaExceededError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as {data?: {quotaExceeded?: unknown}}).data?.quotaExceeded === true)
}

// YouTube quotas reset at midnight Pacific time, which is 08:00 UTC in winter and 07:00 UTC in summer.
export function nextQuotaResetAt(now = new Date()): Date {
    const pacific = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", {timeZone: "America/Los_Angeles", hourCycle: "h23", ...options}).formatToParts(date)
    const parts = Object.fromEntries(pacific(now, {year: "numeric", month: "numeric", day: "numeric"}).map((part) => [part.type, part.value]))
    const winterReset = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1, 8))
    const hour = Number(pacific(winterReset, {hour: "numeric"}).find((part) => part.type === "hour")?.value || 0)
    return new Date(winterReset.getTime() - hour * 60 * 60 * 1000)
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

// A playlist read failed because that playlist is no longer on the provider.
export function isMissingPlaylistError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false
    }
    const record = error as {message?: unknown; statusMessage?: unknown}
    return /API request failed \(404\)/.test(`${record.statusMessage || ""} ${record.message || ""}`)
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
        if (account.provider === "youtube" && (await youtubeErrorReasons(response)).some((reason) => youtubeQuotaReasons.has(reason))) {
            logger.warn("Provider.request", ...logParts, "Daily quota exceeded")
            throw createError({statusCode: 429, statusMessage: youtubeQuotaMessage, data: {quotaExceeded: true}})
        }
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
