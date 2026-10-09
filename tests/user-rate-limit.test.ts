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
