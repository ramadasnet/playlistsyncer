import {describe, expect, test} from "bun:test"
import {isPublicSafeMode, parseBooleanEnvFlag, resolvePublicSafeMode} from "../shared/env-flag"
import {parseServerConfig, resolveAppUrl} from "../server/utils/config"

describe("server configuration", () => {
    test("treats blank optional credentials as unconfigured", () => {
        const config = parseServerConfig({spotifyClientId: "", tokenEncryptionKey: ""})

        expect(config.spotifyClientId).toBeUndefined()
        expect(config.tokenEncryptionKey).toBeUndefined()
        expect(config.mongodbDatabase).toBe("playlistsync")
        expect(config.creemServer).toBe("test")
        expect(config.smtpHost).toBeUndefined()
        expect(config.smtpPort).toBe(587)
        expect(config.proSyncIntervalHours).toBe(12)
    })

    test("parses the PRO automatic sync interval in hours", () => {
        expect(parseServerConfig({proSyncIntervalHours: "6"}).proSyncIntervalHours).toBe(6)
        expect(() => parseServerConfig({proSyncIntervalHours: 0})).toThrow()
    })

    test("accepts Creem production configuration", () => {
        const config = parseServerConfig({
            creemApiKey: "creem_live_key",
            creemWebhookSecret: "webhook_secret",
            creemProProductId: "prod_123",
            creemServer: "prod"
        })

        expect(config.creemApiKey).toBe("creem_live_key")
        expect(config.creemServer).toBe("prod")
    })

    test("parses development PRO users as normalized email addresses", () => {
        const config = parseServerConfig({developmentProUserEmails: " Alice@example.com,BOB@example.com "})

        expect(config.developmentProUserEmails).toEqual(["alice@example.com", "bob@example.com"])
    })

    test("parses the PRO subscription-required instant", () => {
        expect(parseServerConfig({}).proSubscriptionRequiredAt).toBeUndefined()
        expect(parseServerConfig({proSubscriptionRequiredAt: ""}).proSubscriptionRequiredAt).toBeUndefined()
        expect(parseServerConfig({proSubscriptionRequiredAt: "2027-01-01"}).proSubscriptionRequiredAt).toEqual(new Date("2027-01-01"))
        expect(parseServerConfig({proSubscriptionRequiredAt: "2027-01-01T00:00:00.000Z"}).proSubscriptionRequiredAt).toEqual(new Date("2027-01-01T00:00:00.000Z"))
        expect(() => parseServerConfig({proSubscriptionRequiredAt: "not-a-date"})).toThrow()
    })

    test("uses the configured application origin", () => {
        expect(resolveAppUrl({APP_URL: "https://dev.playlistsyncer.com", NUXT_PUBLIC_SITE_URL: "http://legacy"})).toBe("https://dev.playlistsyncer.com")
        expect(resolveAppUrl({NUXT_PUBLIC_SITE_URL: "http://localhost:3007"})).toBe("http://localhost:3007")
        expect(parseServerConfig({appUrl: "https://dev.playlistsyncer.com/"}).appUrl).toBe("https://dev.playlistsyncer.com")
        expect(() => parseServerConfig({appUrl: "https://dev.playlistsyncer.com/base"})).toThrow()
    })

    test("parses SAFE_MODE as a boolean flag", () => {
        expect(parseServerConfig({}).safeMode).toBe(false)
        expect(parseServerConfig({safeMode: ""}).safeMode).toBe(false)
        expect(parseServerConfig({safeMode: "false"}).safeMode).toBe(false)
        expect(parseServerConfig({safeMode: "true"}).safeMode).toBe(true)
        expect(parseServerConfig({safeMode: "1"}).safeMode).toBe(true)
        expect(parseServerConfig({safeMode: "yes"}).safeMode).toBe(true)
        expect(parseServerConfig({safeMode: "on"}).safeMode).toBe(true)
        expect(parseServerConfig({safeMode: true}).safeMode).toBe(true)
        expect(() => parseServerConfig({safeMode: "maybe"})).toThrow()
    })

    test("resolves SAFE_MODE for the public header flag", () => {
        expect(resolvePublicSafeMode({})).toBe(false)
        expect(resolvePublicSafeMode({SAFE_MODE: "true"})).toBe(true)
        expect(resolvePublicSafeMode({SAFE_MODE: "false"}, true)).toBe(false)
        expect(isPublicSafeMode(true)).toBe(true)
        expect(isPublicSafeMode("true")).toBe(true)
        expect(isPublicSafeMode("false")).toBe(false)
        expect(parseBooleanEnvFlag("maybe")).toBeUndefined()
    })
})
