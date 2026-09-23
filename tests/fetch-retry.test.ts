import {afterAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {fetchRetryDefaults, fetchWithRetry, parseRetryAfter} from "../server/utils/fetch-retry"

const originalFetch = globalThis.fetch
const originalDefaults = {...fetchRetryDefaults}
const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => new Response("{}"))
const url = "https://api.example.com/v1/items"

describe("fetchWithRetry", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as unknown as typeof fetch
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
        Object.assign(fetchRetryDefaults, originalDefaults)
    })

    test("parses Retry-After seconds and HTTP dates", () => {
        const now = Date.parse("2026-09-22T20:00:00.000Z")

        expect(parseRetryAfter(null)).toBeUndefined()
        expect(parseRetryAfter("3")).toBe(3000)
        expect(parseRetryAfter("Tue, 22 Sep 2026 20:00:05 GMT", now)).toBe(5000)
        expect(parseRetryAfter("Tue, 22 Sep 2026 19:59:00 GMT", now)).toBe(0)
        expect(parseRetryAfter("soon")).toBeUndefined()
    })

    test.each([408, 429, 500, 502, 503, 504])("retries GET requests after status %d", async (status) => {
        fetchMock.mockResolvedValueOnce(new Response("", {status}))
        fetchMock.mockResolvedValueOnce(new Response("ok"))

        const response = await fetchWithRetry(url)

        expect(await response.text()).toBe("ok")
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("returns the last response after exhausting retries", async () => {
        fetchMock.mockImplementation(async () => new Response("", {status: 502}))

        const response = await fetchWithRetry(url, {}, {maxRetries: 2})

        expect(response.status).toBe(502)
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    test("does not retry client errors", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 404}))

        expect((await fetchWithRetry(url)).status).toBe(404)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("retries POST requests on 429 only", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "0"}}))
        fetchMock.mockResolvedValueOnce(new Response("", {status: 502}))

        const response = await fetchWithRetry(url, {method: "POST", body: "{}"})

        expect(response.status).toBe(502)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("retries POST requests on server errors when marked safe to repeat", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 503}))
        fetchMock.mockResolvedValueOnce(new Response("ok"))

        const response = await fetchWithRetry(url, {method: "POST", body: "{}"}, {retryUnsafe: true})

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("honors Retry-After delays", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "0.05"}}))
        fetchMock.mockResolvedValueOnce(new Response("ok"))
        const startedAt = Date.now()

        await fetchWithRetry(url)

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("gives up when Retry-After exceeds the allowed wait", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "120"}}))

        expect((await fetchWithRetry(url)).status).toBe(429)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("retries GET requests after network errors", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
        fetchMock.mockResolvedValueOnce(new Response("ok"))

        expect((await fetchWithRetry(url)).status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("does not retry POST requests after network errors", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))

        await expect(fetchWithRetry(url, {method: "POST", body: "{}"})).rejects.toThrow("fetch failed")
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("does not retry requests aborted by the caller", async () => {
        const controller = new AbortController()
        fetchMock.mockImplementationOnce(async () => {
            controller.abort()
            throw new DOMException("Aborted", "AbortError")
        })

        await expect(fetchWithRetry(url, {signal: controller.signal})).rejects.toThrow("Aborted")
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("retries responses matched by a custom rate limit check for any method", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 403}))
        fetchMock.mockResolvedValueOnce(new Response("ok"))
        const onRateLimited = mock(() => undefined)

        const response = await fetchWithRetry(url, {method: "POST", body: "{}"}, {isRateLimited: (res) => res.status === 403, onRateLimited})

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(onRateLimited).toHaveBeenCalledWith(undefined)
    })

    test("waits for a slot before every attempt and reports rate limits", async () => {
        const beforeAttempt = mock(async () => undefined)
        const onRateLimited = mock(() => undefined)
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "2"}}))
        fetchMock.mockResolvedValueOnce(new Response("ok"))
        const startedAt = Date.now()

        await fetchWithRetry(url, {}, {beforeAttempt, onRateLimited})

        // The limiter owns the cooldown, so the helper does not sleep on Retry-After itself.
        expect(Date.now() - startedAt).toBeLessThan(1000)
        expect(beforeAttempt).toHaveBeenCalledTimes(2)
        expect(onRateLimited).toHaveBeenCalledWith(2000)
    })

    test("reports rate limits even when no retries are left", async () => {
        const onRateLimited = mock(() => undefined)
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "1"}}))

        expect((await fetchWithRetry(url, {}, {maxRetries: 0, onRateLimited})).status).toBe(429)
        expect(onRateLimited).toHaveBeenCalledWith(1000)
    })

    test("replays Request bodies on every attempt", async () => {
        const bodies: string[] = []
        fetchMock.mockImplementation(async (input) => {
            const request = input as Request
            bodies.push(`${request.method} ${await request.text()}`)
            return new Response("", {status: bodies.length === 1 ? 429 : 200})
        })

        const response = await fetchWithRetry(new Request(url, {method: "POST", body: "payload"}))

        expect(response.status).toBe(200)
        expect(bodies).toEqual(["POST payload", "POST payload"])
    })
})
