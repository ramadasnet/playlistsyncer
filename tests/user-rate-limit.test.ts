import {IncomingMessage, ServerResponse} from "node:http"
import {Socket} from "node:net"
import {createEvent} from "h3"
import {describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import logger from "../server/utils/logger"
import {enforceUserRateLimit, SlidingWindowLimiter} from "../server/utils/user-rate-limit"

describe("per-user rate limit", () => {
    test("allows the limit within the window and frees slots as they age out", () => {
        let now = 0
        const limiter = new SlidingWindowLimiter("test", 2, 1000, () => now)

        expect(limiter.take("user")).toBe(0)
        now = 400
        expect(limiter.take("user")).toBe(0)
        now = 500
        expect(limiter.take("user")).toBe(500)
        expect(limiter.take("other-user")).toBe(0)
        now = 1000
        expect(limiter.take("user")).toBe(0)
        expect(limiter.take("user")).toBe(400)
    })

    test("sweeps a large map once per window instead of on every allowed request", () => {
        let now = 0
        const limiter = new SlidingWindowLimiter("test", 1, 1_000, () => now)
        for (let index = 0; index < 10_001; index++) limiter.take(`user-${index}`)
        const scans: number[] = []
        const iterate = Map.prototype[Symbol.iterator]
        const iterator = spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
            if (this.size > 10_000) scans.push(this.size)
            return iterate.call(this)
        })

        try {
            now = 1_000
            expect(limiter.take("fresh")).toBe(0)
            const swept = scans.length
            expect(swept).toBeGreaterThan(0)
            expect(limiter.take("fresh")).toBe(1_000)
            expect(scans.length).toBe(swept)
            expect(limiter.take("user-0")).toBe(0)
        } finally {
            iterator.mockRestore()
        }
    })

    test("a limit of 0 disables the limiter", () => {
        const limiter = new SlidingWindowLimiter("test", 0, 1000)

        for (let index = 0; index < 100; index++) {
            expect(limiter.take("user")).toBe(0)
        }
    })

    test("rejects with 429 and Retry-After once the user is over the limit", () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
        try {
            const limiter = new SlidingWindowLimiter("test", 1, 60_000, () => 0)
            const userId = new ObjectId()
            const request = new IncomingMessage(new Socket())
            const response = new ServerResponse(request)
            const event = createEvent(request, response)

            enforceUserRateLimit(limiter, userId, "Slow down", event)
            expect(() => enforceUserRateLimit(limiter, userId, "Slow down", event)).toThrow(expect.objectContaining({statusCode: 429, statusMessage: "Slow down"}))
            expect(String(response.getHeader("retry-after"))).toBe("60")
            enforceUserRateLimit(limiter, new ObjectId(), "Slow down", event)
        } finally {
            warn.mockRestore()
        }
    })
})
