// Pace provider API requests per provider, shared by every account, and pause them all after a rate limit.
import type {Provider} from "~~/shared/types/domain"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"

// Cooldown applied when a rate-limited response carries no Retry-After header.
const defaultCooldownMs = 5_000
// Requests fail instead of queueing when the provider asks for a longer cooldown than this.
export const maxQueueWaitMs = 5 * 60 * 1000
const maxSlowdown = 8
const slowdownRecoveryMs = 60_000

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

export class ProviderRateLimiter {
    private nextSlotAt = 0
    private pausedUntil = 0
    private slowdown = 1
    private slowdownChangedAt = 0
    private readonly now: () => number
    private readonly cooldownMs: number

    constructor(
        readonly provider: Provider,
        readonly maxRequestsPerMinute: number,
        options: {now?: () => number; cooldownMs?: number} = {}
    ) {
        this.now = options.now ?? Date.now
        this.cooldownMs = options.cooldownMs ?? defaultCooldownMs
    }

    // Spacing between request starts, widened while recovering from a rate limit.
    get intervalMs(): number {
        return this.maxRequestsPerMinute > 0 ? (60_000 / this.maxRequestsPerMinute) * this.slowdown : 0
    }

    get pausedForMs(): number {
        return Math.max(0, this.pausedUntil - this.now())
    }

    // Wait for the next request slot in FIFO order, staying queued while the provider is cooling down.
    async acquire(signal?: AbortSignal | null): Promise<void> {
        for (;;) {
            const now = this.now()
            this.recover(now)
            const slot = Math.max(now, this.nextSlotAt, this.pausedUntil)
            if (this.pausedUntil - now > maxQueueWaitMs) {
                logger.warn("Provider.rateLimit", this.provider, `Cooldown ${Math.ceil((this.pausedUntil - now) / 1000)}s exceeds the queue limit`)
                throw createError({statusCode: 429, statusMessage: `${this.provider} API is rate limited; try again later`})
            }
            this.nextSlotAt = slot + this.intervalMs
            if (slot > now) {
                await wait(slot - now, signal)
            }
            // A rate limit may have arrived while this request was waiting for its slot.
            if (this.pausedUntil <= this.now()) {
                return
            }
        }
    }

    // Pause every queued request for this provider and slow down once the cooldown ends.
    onRateLimited(retryAfterMs?: number): void {
        const now = this.now()
        const cooldownMs = retryAfterMs ?? this.cooldownMs * this.slowdown
        // Concurrent 429s from the same episode extend the pause without compounding the slowdown.
        const newEpisode = this.pausedUntil <= now
        this.pausedUntil = Math.max(this.pausedUntil, now + cooldownMs)
        if (newEpisode) {
            this.slowdown = Math.min(maxSlowdown, this.slowdown * 2)
            this.slowdownChangedAt = now
            const pacing = this.maxRequestsPerMinute > 0 ? `Pacing ${Math.floor(this.maxRequestsPerMinute / this.slowdown)}/min` : "Pacing unlimited"
            logger.warn("Provider.rateLimit", this.provider, `Paused ${Math.ceil(cooldownMs / 1000)}s`, pacing)
        }
    }

    // Halve the slowdown once for every full recovery interval elapsed since the last change or cooldown.
    private recover(now: number): void {
        const steps = Math.floor((now - Math.max(this.slowdownChangedAt, this.pausedUntil)) / slowdownRecoveryMs)
        if (this.slowdown > 1 && this.pausedUntil <= now && steps > 0) {
            this.slowdown = Math.max(1, this.slowdown / 2 ** steps)
            this.slowdownChangedAt = now
        }
    }
}

export const providerRateLimiters = new Map<Provider, ProviderRateLimiter>()

// Return the process-wide limiter for a provider, configured from its requests-per-minute setting.
export function getProviderRateLimiter(provider: Provider): ProviderRateLimiter {
    let limiter = providerRateLimiters.get(provider)
    if (!limiter) {
        limiter = new ProviderRateLimiter(provider, getServerConfig()[`${provider}MaxRequestsPerMinute`])
        providerRateLimiters.set(provider, limiter)
    }
    return limiter
}
