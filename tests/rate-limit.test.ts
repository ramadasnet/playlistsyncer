import {describe, expect, test} from "bun:test"

;(globalThis as {createError?: unknown}).createError = (input: {statusCode: number; statusMessage: string}) => Object.assign(new Error(input.statusMessage), input)

const {ProviderRateLimiter, maxQueueWaitMs} = await import("../server/domain/providers/rate-limit")

describe("provider rate limiter", () => {
    test("spaces request starts to stay under the configured requests per minute", async () => {
        const limiter = new ProviderRateLimiter("spotify", 3000)
        const startedAt = Date.now()

        const times = await Promise.all([0, 1, 2].map(() => limiter.acquire().then(() => Date.now() - startedAt)))

        expect(limiter.intervalMs).toBe(20)
        expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(15)
        expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(15)
    })

    test("queues every request while the provider is cooling down", async () => {
        const limiter = new ProviderRateLimiter("spotify", 0)
        limiter.onRateLimited(80)
        const startedAt = Date.now()

        await Promise.all([limiter.acquire(), limiter.acquire()])

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75)
    })

    test("holds requests that were already waiting when a rate limit arrives", async () => {
        const limiter = new ProviderRateLimiter("spotify", 600)
        const startedAt = Date.now()
        await limiter.acquire()
        const waiting = limiter.acquire().then(() => Date.now() - startedAt)

        await Bun.sleep(20)
        limiter.onRateLimited(200)

        expect(await waiting).toBeGreaterThanOrEqual(215)
    })

    test("slows down after a rate limit and recovers once it has cleared", async () => {
        let now = 1_000_000
        const limiter = new ProviderRateLimiter("spotify", 120, {now: () => now})

        limiter.onRateLimited(1000)
        // Concurrent 429s from the same burst do not compound the slowdown.
        limiter.onRateLimited(0)
        limiter.onRateLimited(500)
        expect(limiter.intervalMs).toBe(1000)

        now += 1000 + 60_000
        await limiter.acquire()
        expect(limiter.intervalMs).toBe(500)
    })

    test("applies every recovery step that elapsed while the limiter was idle", async () => {
        let now = 1_000_000
        const limiter = new ProviderRateLimiter("spotify", 120, {now: () => now})
        for (let episode = 0; episode < 3; episode++) {
            limiter.onRateLimited(1000)
            now += 1000
        }
        expect(limiter.intervalMs).toBe(4000)

        now += 3 * 60_000
        await limiter.acquire()
        expect(limiter.intervalMs).toBe(500)
    })

    test("queues a pacing backlog longer than the cooldown limit", async () => {
        let now = 1_000_000
        const sleepers: {ms: number; resolve: () => void}[] = []
        const limiter = new ProviderRateLimiter("spotify", 1, {
            now: () => now,
            wait: (ms) => new Promise((resolve) => sleepers.push({ms, resolve}))
        })
        const queued = Array.from({length: maxQueueWaitMs / 60_000 + 2}, () => limiter.acquire())

        expect(sleepers.map((sleeper) => sleeper.ms)).toEqual([60_000, 120_000, 180_000, 240_000, 300_000, 360_000])
        now += 360_000
        sleepers.forEach((sleeper) => sleeper.resolve())

        await expect(Promise.all(queued)).resolves.toEqual(Array(7).fill(undefined))
    })

    test("uses the default cooldown when the provider sends no Retry-After", () => {
        const limiter = new ProviderRateLimiter("spotify", 0, {now: () => 0, cooldownMs: 3000})

        limiter.onRateLimited()

        expect(limiter.pausedForMs).toBe(3000)
    })

    test("fails fast when the cooldown is longer than requests may queue", async () => {
        const limiter = new ProviderRateLimiter("spotify", 0)
        limiter.onRateLimited(maxQueueWaitMs + 60_000)

        await expect(limiter.acquire()).rejects.toMatchObject({statusCode: 429})
    })

    test("stops waiting when the request is aborted", async () => {
        const limiter = new ProviderRateLimiter("spotify", 0)
        const controller = new AbortController()
        limiter.onRateLimited(10_000)

        const waiting = limiter.acquire(controller.signal)
        controller.abort(new Error("Cancelled"))

        await expect(waiting).rejects.toThrow("Cancelled")
    })
})
