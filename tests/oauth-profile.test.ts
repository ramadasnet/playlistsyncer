import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {getOAuthProvider} from "../server/domain/auth/providers"
import {ProviderRateLimiter, providerRateLimiters} from "../server/domain/providers/rate-limit"
import {getServerConfig} from "../server/utils/config"
import {fetchRetryDefaults} from "../server/utils/fetch-retry"

const originalFetch = globalThis.fetch
const config = getServerConfig()
const originalClientId = config.spotifyClientId
const originalClientSecret = config.spotifyClientSecret
const originalDefaults = {...fetchRetryDefaults}
const fetchMock = mock(async (): Promise<Response> => new Response(JSON.stringify({id: "listener", display_name: "Listener"})))

describe("OAuth provider profile requests", () => {
    beforeEach(() => {
        config.spotifyClientId = "test-client-id"
        config.spotifyClientSecret = "test-client-secret"
        globalThis.fetch = fetchMock as typeof fetch
        fetchMock.mockReset()
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
    })

    afterAll(() => {
        config.spotifyClientId = originalClientId
        config.spotifyClientSecret = originalClientSecret
        globalThis.fetch = originalFetch
        Object.assign(fetchRetryDefaults, originalDefaults)
        providerRateLimiters.delete("spotify")
    })

    test("uses the shared provider limiter on retries and falls back from blank names", async () => {
        const limiter = new ProviderRateLimiter("spotify", 0, {cooldownMs: 0})
        providerRateLimiters.set("spotify", limiter)
        const acquire = spyOn(limiter, "acquire")
        const onRateLimited = spyOn(limiter, "onRateLimited")
        fetchMock.mockResolvedValueOnce(new Response("", {status: 429, headers: {"Retry-After": "0"}}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({id: "listener", display_name: " ", email: "listener@example.test"})))

        const profile = await getOAuthProvider("spotify").fetchProfile("test-access-token")

        expect(profile.displayName).toBe("listener@example.test")
        expect(acquire).toHaveBeenCalledTimes(2)
        expect(onRateLimited).toHaveBeenCalledWith(0)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})
