import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {getOAuthProvider} from "../server/domain/auth/providers"
import {ProviderRateLimiter, providerRateLimiters} from "../server/domain/providers/rate-limit"
import {getServerConfig} from "../server/utils/config"
import {fetchRetryDefaults} from "../server/utils/fetch-retry"

const originalFetch = globalThis.fetch
const config = getServerConfig()
const originalClientId = config.spotifyClientId
const originalClientSecret = config.spotifyClientSecret
const originalSoundCloudClientId = config.soundcloudClientId
const originalSoundCloudClientSecret = config.soundcloudClientSecret
const originalAmazonClientId = config.amazonClientId
const originalAmazonClientSecret = config.amazonClientSecret
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
        config.soundcloudClientId = originalSoundCloudClientId
        config.soundcloudClientSecret = originalSoundCloudClientSecret
        config.amazonClientId = originalAmazonClientId
        config.amazonClientSecret = originalAmazonClientSecret
        globalThis.fetch = originalFetch
        Object.assign(fetchRetryDefaults, originalDefaults)
        providerRateLimiters.delete("spotify")
        providerRateLimiters.delete("soundcloud")
        providerRateLimiters.delete("amazon")
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

    test("never trusts a Spotify email and keys the account on the immutable account_id", async () => {
        providerRateLimiters.set("spotify", new ProviderRateLimiter("spotify", 0, {cooldownMs: 0}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({id: "listener", account_id: "aB3dE5fG7h", display_name: "Listener", email: "victim@example.test"})))

        const profile = await getOAuthProvider("spotify").fetchProfile("test-access-token")

        expect(profile).toMatchObject({id: "aB3dE5fG7h", previousIds: ["listener"], email: "victim@example.test", emailVerified: false})
    })

    test("falls back to the Spotify user id when account_id is missing", async () => {
        providerRateLimiters.set("spotify", new ProviderRateLimiter("spotify", 0, {cooldownMs: 0}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({id: "listener", display_name: "Listener", email: "listener@example.test"})))

        const profile = await getOAuthProvider("spotify").fetchProfile("test-access-token")

        expect(profile.id).toBe("listener")
        expect(profile.previousIds).toBeUndefined()
        expect(profile.emailVerified).toBe(false)
    })

    test("never trusts an Amazon email", async () => {
        config.amazonClientId = "amazon-client-id"
        config.amazonClientSecret = "amazon-client-secret"
        providerRateLimiters.set("amazon", new ProviderRateLimiter("amazon", 0, {cooldownMs: 0}))
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({user_id: "amzn1.account.1", email: "victim@example.test", name: "Listener"})))

        const profile = await getOAuthProvider("amazon").fetchProfile("test-access-token")

        expect(profile.emailVerified).toBe(false)
    })

    test("reads a SoundCloud profile with the OAuth scheme and without an email", async () => {
        config.soundcloudClientId = "soundcloud-client-id"
        config.soundcloudClientSecret = "soundcloud-client-secret"
        const limiter = new ProviderRateLimiter("soundcloud", 0, {cooldownMs: 0})
        providerRateLimiters.set("soundcloud", limiter)
        const acquire = spyOn(limiter, "acquire")
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({urn: "soundcloud:users:42", full_name: " ", username: "listener", avatar_url: " "})))

        const profile = await getOAuthProvider("soundcloud").fetchProfile("test-access-token")

        expect(profile).toEqual({
            id: "soundcloud:users:42",
            emailVerified: false,
            displayName: "listener",
            avatarUrl: undefined
        })
        const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers)
        expect(headers.get("Authorization")).toBe("OAuth test-access-token")
        expect(headers.get("Accept")).toBe("application/json; charset=utf-8")
        expect(acquire).toHaveBeenCalledTimes(1)
    })
})
