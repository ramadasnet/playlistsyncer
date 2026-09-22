// Perform external HTTP requests with timeouts and retries for transient failures.
import logger from "./logger"

export interface FetchRetryOptions {
    // Log label used when a retry is scheduled.
    label?: string
    // Maximum number of retries after the first attempt.
    maxRetries?: number
    // Timeout for each individual attempt.
    timeoutMs?: number
    // Longest Retry-After delay honored; longer delays return the response without retrying.
    maxRetryAfterMs?: number
    // Retry non-idempotent methods on server errors and network failures, not only on 429.
    retryUnsafe?: boolean
    // Extra check for provider-specific rate limit responses (for example YouTube 403 rateLimitExceeded).
    isRateLimited?: (response: Response) => boolean | Promise<boolean>
    // Wait before each attempt, for example for a slot from a shared rate limiter.
    beforeAttempt?: (signal: AbortSignal | null | undefined) => Promise<void>
    // Notified on every rate limited response, with its Retry-After delay when present.
    onRateLimited?: (retryAfterMs: number | undefined) => void
}

export const fetchRetryDefaults = {
    maxRetries: 3,
    timeoutMs: 30_000,
    maxRetryAfterMs: 30_000,
    baseDelayMs: 500,
    maxDelayMs: 8_000
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504])
const idempotentMethods = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])

// Parse a Retry-After header, given either as seconds or as an HTTP date.
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
    if (!value) {
        return undefined
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000)
    }
    const date = Date.parse(value)
    return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

// Exponential backoff with full jitter.
function backoffDelay(attempt: number): number {
    const cap = Math.min(fetchRetryDefaults.maxDelayMs, fetchRetryDefaults.baseDelayMs * 2 ** attempt)
    return Math.round(Math.random() * cap)
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(signal.reason)
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal!.reason)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        signal?.addEventListener("abort", onAbort, {once: true})
    })
}

// Fetch a URL, retrying rate limits, transient server errors and network failures with backoff.
export async function fetchWithRetry(input: string | URL | Request, init: RequestInit = {}, options: FetchRetryOptions = {}): Promise<Response> {
    const request = input instanceof Request ? input : undefined
    const method = (init.method || request?.method || "GET").toUpperCase()
    const callerSignal = init.signal ?? request?.signal
    const maxRetries = options.maxRetries ?? fetchRetryDefaults.maxRetries
    const timeoutMs = options.timeoutMs ?? fetchRetryDefaults.timeoutMs
    const maxRetryAfterMs = options.maxRetryAfterMs ?? fetchRetryDefaults.maxRetryAfterMs
    const safeToRepeat = options.retryUnsafe || idempotentMethods.has(method)
    const url = new URL(request?.url ?? input.toString())
    const target = `${url.hostname}${url.pathname}`

    for (let attempt = 0; ; attempt++) {
        await options.beforeAttempt?.(callerSignal)
        const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        const canRetry = attempt < maxRetries
        let response: Response
        try {
            response = request ? await fetch(new Request(request.clone(), {signal})) : await fetch(input, {...init, signal})
        } catch (ex) {
            // Network failures and timeouts may have reached the server, so only repeat safe requests.
            if (callerSignal?.aborted || !canRetry || !safeToRepeat) {
                throw ex
            }
            const delay = backoffDelay(attempt)
            logger.warn(options.label || "Http.fetch", method, target, `Attempt ${attempt + 1}`, (ex as Error).name === "TimeoutError" ? "Timed out" : "Network error", `Retrying in ${delay}ms`)
            await wait(delay, callerSignal)
            continue
        }
        if (response.ok) {
            return response
        }

        // Rate limited requests were rejected before processing, so they can be repeated for any method.
        const rateLimited = response.status === 429 || Boolean(await options.isRateLimited?.(response))
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"))
        if (rateLimited) {
            options.onRateLimited?.(retryAfter)
        }
        const retryable = rateLimited || (safeToRepeat && retryableStatuses.has(response.status))
        if (!canRetry || !retryable) {
            return response
        }
        if (retryAfter !== undefined && retryAfter > maxRetryAfterMs) {
            return response
        }
        // A shared limiter already holds the retry until the cooldown ends, keeping its place in the queue.
        const delay = rateLimited && options.beforeAttempt ? 0 : (retryAfter ?? backoffDelay(attempt))
        await response.body?.cancel().catch(() => undefined)
        logger.warn(options.label || "Http.fetch", method, target, `Status ${response.status}`, `Attempt ${attempt + 1}`, delay ? `Retrying in ${delay}ms` : "Queued until the rate limit clears")
        await wait(delay, callerSignal)
    }
}
