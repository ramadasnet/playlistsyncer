import {describe, expect, test} from "bun:test"
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

    test("uses the configured application origin", () => {
        expect(resolveAppUrl({APP_URL: "https://dev.playlistsyncer.com", NUXT_PUBLIC_SITE_URL: "http://legacy"})).toBe(
            "https://dev.playlistsyncer.com"
        )
        expect(resolveAppUrl({NUXT_PUBLIC_SITE_URL: "http://localhost:3007"})).toBe("http://localhost:3007")
        expect(parseServerConfig({appUrl: "https://dev.playlistsyncer.com/"}).appUrl).toBe(
            "https://dev.playlistsyncer.com"
        )
        expect(() => parseServerConfig({appUrl: "https://dev.playlistsyncer.com/base"})).toThrow()
    })
})
