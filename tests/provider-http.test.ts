import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"
import * as token from "../server/domain/providers/token"
import {providerFetch} from "../server/domain/providers/http"
import {fetchRetryDefaults} from "../server/utils/fetch-retry"
import {ProviderRateLimiter, providerRateLimiters} from "../server/domain/providers/rate-limit"

const getAccessToken = mock(async () => "token")

// A spy instead of mock.module, which would replace getAccessToken for every later test file.
const getAccessTokenSpy = spyOn(token, "getAccessToken").mockImplementation(getAccessToken)
afterAll(() => getAccessTokenSpy.mockRestore())
;(globalThis as {createError?: unknown}).createError = (input: {statusCode: number; statusMessage: string}) => Object.assign(new Error(input.statusMessage), input)
const spotify = {provider: "spotify", externalAccountId: "account-id"} as ProviderAccountDocument
const otherSpotify = {provider: "spotify", externalAccountId: "other-account-id"} as ProviderAccountDocument
const youtube = {provider: "youtube", externalAccountId: "account-id"} as ProviderAccountDocument
const soundcloud = {provider: "soundcloud", externalAccountId: "account-id"} as ProviderAccountDocument
const providerMaxRetries = 5
const originalFetch = globalThis.fetch
const originalDefaults = {...fetchRetryDefaults}
const fetchMock = mock(async (): Promise<Response> => new Response("{}"))
const youtubeError = (reason: string) => new Response(JSON.stringify({error: {errors: [{reason}]}}), {status: 403})

describe("Provider HTTP requests", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        getAccessToken.mockClear()
        globalThis.fetch = fetchMock as unknown as typeof fetch
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
        providerRateLimiters.set("spotify", new ProviderRateLimiter("spotify", 0, {cooldownMs: 0}))
        providerRateLimiters.set("youtube", new ProviderRateLimiter("youtube", 0, {cooldownMs: 0}))
        providerRateLimiters.set("soundcloud", new ProviderRateLimiter("soundcloud", 0, {cooldownMs: 0}))
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
        Object.assign(fetchRetryDefaults, originalDefaults)
        providerRateLimiters.clear()
    })

    test("retries transient upstream errors before failing a sync", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 502}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ok: true})))

        await expect(providerFetch(spotify, "https://api.spotify.com/v1/search?q=test")).resolves.toEqual({ok: true})
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("maps exhausted server errors to 502", async () => {
        fetchMock.mockImplementation(async () => new Response("", {status: 503}))

        await expect(providerFetch(spotify, "https://api.spotify.com/v1/search?q=test")).rejects.toMatchObject({statusCode: 502})
        expect(fetchMock).toHaveBeenCalledTimes(providerMaxRetries + 1)
    })

    test("maps exhausted rate limits to 429", async () => {
        fetchMock.mockImplementation(async () => new Response("", {status: 429, headers: {"Retry-After": "0"}}))

        await expect(providerFetch(spotify, "https://api.spotify.com/v1/playlists/id/items", {method: "POST", body: "{}"})).rejects.toMatchObject({statusCode: 429})
        expect(fetchMock).toHaveBeenCalledTimes(providerMaxRetries + 1)
    })

    test("queues other accounts' requests while the provider is rate limited", async () => {
        const calls: {account: string; at: number}[] = []
        const startedAt = Date.now()
        fetchMock.mockImplementation(async (...args: unknown[]) => {
            const account = String(args[0]).includes("first") ? "A" : "B"
            calls.push({account, at: Date.now() - startedAt})
            return calls.length === 1 ? new Response("", {status: 429, headers: {"Retry-After": "0.15"}}) : new Response(JSON.stringify({ok: true}))
        })

        const first = providerFetch(spotify, "https://api.spotify.com/v1/search?q=first")
        await Bun.sleep(20)
        const second = providerFetch(otherSpotify, "https://api.spotify.com/v1/search?q=second")

        await expect(Promise.all([first, second])).resolves.toEqual([{ok: true}, {ok: true}])
        expect(calls).toHaveLength(3)
        expect(calls[0]!.account).toBe("A")
        // User B never hit the provider during user A's cooldown, and both resumed once it cleared.
        expect(calls.slice(1).every((call) => call.at >= 140)).toBe(true)
    })

    test("does not retry additions after server errors", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 502}))

        await expect(providerFetch(spotify, "https://api.spotify.com/v1/playlists/id/items", {method: "POST", body: "{}"})).rejects.toMatchObject({statusCode: 502})
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("refreshes the token once after a 401", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 401}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ok: true})))

        await expect(providerFetch(spotify, "https://api.spotify.com/v1/me")).resolves.toEqual({ok: true})
        expect(getAccessToken).toHaveBeenLastCalledWith(spotify, {force: true})
    })

    test("retries YouTube rate limit 403s but not quota exhaustion", async () => {
        fetchMock.mockResolvedValueOnce(youtubeError("rateLimitExceeded"))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({items: []})))

        await expect(providerFetch(youtube, "https://www.googleapis.com/youtube/v3/search?q=test")).resolves.toEqual({items: []})
        expect(fetchMock).toHaveBeenCalledTimes(2)

        fetchMock.mockReset()
        fetchMock.mockResolvedValueOnce(youtubeError("quotaExceeded"))

        await expect(providerFetch(youtube, "https://www.googleapis.com/youtube/v3/search?q=test")).rejects.toMatchObject({statusCode: 502})
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("sends SoundCloud's OAuth scheme and accepts an empty success body", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", {status: 200}))

        await expect(providerFetch(soundcloud, "https://api.soundcloud.com/playlists/soundcloud:playlists:1", {method: "DELETE"})).resolves.toBeUndefined()

        const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers)
        expect(headers.get("Authorization")).toBe("OAuth token")
    })

    test("maps exhausted YouTube rate limit 403s to 429", async () => {
        fetchMock.mockImplementation(async () => youtubeError("userRateLimitExceeded"))

        await expect(providerFetch(youtube, "https://www.googleapis.com/youtube/v3/playlistItems", {method: "POST", body: "{}"})).rejects.toMatchObject({statusCode: 429})
        expect(fetchMock).toHaveBeenCalledTimes(providerMaxRetries + 1)
    })
})
