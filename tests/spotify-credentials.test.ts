import {describe, expect, test, afterAll} from "bun:test"
import {createError} from "h3"
import {getOAuthProvider, spotifyCredentialPool} from "../server/domain/auth/providers"
import {getServerConfig, parseServerConfig} from "../server/utils/config"

const globals = globalThis as Record<string, unknown>
const originalCreateError = globals.createError
globals.createError = createError

const config = getServerConfig()
const originalConfig = {...config}

afterAll(() => {
    Object.assign(config, originalConfig)
    if (originalCreateError === undefined) delete globals.createError
    else globals.createError = originalCreateError
})

describe("spotify credential pool", () => {
    test("leads with the primary pair and deduplicates by client ID", () => {
        const pool = spotifyCredentialPool(
            parseServerConfig({
                spotifyClientId: "primary-id",
                spotifyClientSecret: "primary-secret",
                spotifyCredentials: "primary-id:other-secret, second-id:second-secret"
            })
        )
        expect(pool).toEqual([
            {clientId: "primary-id", clientSecret: "primary-secret"},
            {clientId: "second-id", clientSecret: "second-secret"}
        ])
    })

    test("enables Spotify from pooled credentials alone", () => {
        const pool = spotifyCredentialPool(parseServerConfig({spotifyCredentials: "only-id:only-secret"}))
        expect(pool).toEqual([{clientId: "only-id", clientSecret: "only-secret"}])
    })

    test("resolves the requested app credentials for OAuth", () => {
        Object.assign(config, {spotifyClientId: "primary-id", spotifyClientSecret: "primary-secret", spotifyCredentials: [{clientId: "second-id", clientSecret: "second-secret"}]})

        expect(getOAuthProvider("spotify").clientId).toBe("primary-id")
        expect(getOAuthProvider("spotify", "second-id")).toMatchObject({clientId: "second-id", clientSecret: "second-secret"})
        expect(() => getOAuthProvider("spotify", "unknown-id")).toThrow()
    })
})
