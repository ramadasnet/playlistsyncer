// Limit how often one user can trigger an expensive action, counted in memory by the web server process.
import {createError, setResponseHeader, type H3Event} from "h3"
import type {ObjectId} from "mongodb"
import {getServerConfig} from "./config"
import logger from "./logger"

// Stale keys are swept once the map grows past this size, so idle users do not accumulate.
const sweepThreshold = 10_000

export class SlidingWindowLimiter {
    private readonly hits = new Map<string, number[]>()
    private lastSweepAt = Number.NEGATIVE_INFINITY

    constructor(
        readonly label: string,
        readonly limit: number,
        readonly windowMs: number,
        private readonly now: () => number = Date.now
    ) {}

    // Record one action for the key and return 0, or return the milliseconds left until the key may act again. A limit of 0 disables it.
    take(key: string): number {
        if (this.limit <= 0) {
            return 0
        }
        const now = this.now()
        this.sweep(now)
        const recent = (this.hits.get(key) || []).filter((at) => now - at < this.windowMs)
        if (recent.length >= this.limit) {
            this.hits.set(key, recent)
            return recent[0]! + this.windowMs - now
        }
        recent.push(now)
        this.hits.set(key, recent)
        return 0
    }

    // Drop expired keys at most once per window after the map is large, instead of scanning it on every allowed request.
    private sweep(now: number): void {
        if (this.hits.size <= sweepThreshold || now - this.lastSweepAt < this.windowMs) {
            return
        }
        this.lastSweepAt = now
        for (const [staleKey, times] of this.hits) {
            const latest = times[times.length - 1]
            if (latest !== undefined && now - latest >= this.windowMs) this.hits.delete(staleKey)
        }
    }
}

// Reject with 429 once the user has used up the limiter's window, and tell the client when to retry.
export function enforceUserRateLimit(limiter: SlidingWindowLimiter, userId: ObjectId, statusMessage: string, event?: H3Event): void {
    const retryAfterMs = limiter.take(userId.toHexString())
    if (!retryAfterMs) {
        return
    }
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000)
    if (event) {
        setResponseHeader(event, "Retry-After", retryAfterSeconds)
    }
    logger.warn("RateLimit.user", limiter.label, `User ${userId.toHexString()}`, `Retry after ${retryAfterSeconds}s`)
    throw createError({statusCode: 429, statusMessage})
}

let providerRequestLimiter: SlidingWindowLimiter | undefined

// Cap requests that call music providers, so one user cannot drain the provider rate limit shared by every user.
export function enforceProviderRequestLimit(event: H3Event, userId: ObjectId): void {
    providerRequestLimiter ??= new SlidingWindowLimiter("providerRequests", getServerConfig().userProviderRequestsPerMinute, 60_000)
    enforceUserRateLimit(providerRequestLimiter, userId, "Too many music provider requests. Wait a minute and try again.", event)
}
