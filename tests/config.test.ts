import {describe, expect, test} from "bun:test"
import {isPublicSafeMode, parseBooleanEnvFlag, resolvePublicSafeMode} from "../shared/env-flag"
import {checkStartupConfig, clearServerConfigCache, getServerConfig, parseServerConfig, resolveAppUrl} from "../server/utils/config"

const productionValues = {
    appUrl: "https://playlistsyncer.com",
    mongodbUri: "mongodb://db.example.com:27017/playlistsync",
    sessionSecret: "session-secret",
    tokenEncryptionKey: "encryption-key",
    schedulerSecret: "scheduler-secret"
}

describe("server configuration", () => {
    test("treats blank optional credentials as unconfigured", () => {
        const config = parseServerConfig({spotifyClientId: "", tokenEncryptionKey: ""})

        expect(config.spotifyClientId).toBeUndefined()
        expect(config.tokenEncryptionKey).toBeUndefined()
        expect(config.mongodbDatabase).toBe("playlistsync")
        expect(config.creemServer).toBe("test")
        expect(config.smtpHost).toBeUndefined()
        expect(config.smtpPort).toBe(587)
        expect(config.proSyncIntervalMinutes).toBe(720)
    })

    test("parses the PRO automatic sync interval in minutes", () => {
        expect(parseServerConfig({proSyncIntervalMinutes: "90"}).proSyncIntervalMinutes).toBe(90)
        expect(() => parseServerConfig({proSyncIntervalMinutes: 0})).toThrow()
        expect(() => parseServerConfig({proSyncIntervalMinutes: 1.5})).toThrow()
    })

    test("parses provider request limits per minute with defaults", () => {
        const defaults = parseServerConfig({spotifyMaxRequestsPerMinute: ""})
        const config = parseServerConfig({spotifyMaxRequestsPerMinute: "90", tidalMaxRequestsPerMinute: "0"})

        expect([defaults.spotifyMaxRequestsPerMinute, defaults.youtubeMaxRequestsPerMinute, defaults.tidalMaxRequestsPerMinute, defaults.soundcloudMaxRequestsPerMinute, defaults.amazonMaxRequestsPerMinute]).toEqual([120, 300, 60, 60, 60])
        expect(config.spotifyMaxRequestsPerMinute).toBe(90)
        expect(config.tidalMaxRequestsPerMinute).toBe(0)
        expect(() => parseServerConfig({youtubeMaxRequestsPerMinute: "-1"})).toThrow()
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
        expect(resolveAppUrl({PLS_APP_URL: "https://dev.playlistsyncer.com"})).toBe("https://dev.playlistsyncer.com")
        expect(parseServerConfig({appUrl: "https://dev.playlistsyncer.com/"}).appUrl).toBe("https://dev.playlistsyncer.com")
        expect(() => parseServerConfig({appUrl: "https://dev.playlistsyncer.com/base"})).toThrow()
    })

    test("refuses a production start without secrets or a public app URL", () => {
        const website = checkStartupConfig(parseServerConfig({}), "website", true)
        const jobs = checkStartupConfig(parseServerConfig({}), "jobs", true)

        expect(website.errors).toEqual(["PLS_MONGODB_URI is required", "PLS_TOKEN_ENCRYPTION_KEY is required", "PLS_SESSION_SECRET is required", "PLS_APP_URL must be the public https origin, not http://localhost:3007"])
        expect(jobs.errors).toContain("PLS_SCHEDULER_SECRET is required")
        expect(jobs.errors).not.toContain("PLS_SESSION_SECRET is required")
        expect(checkStartupConfig(parseServerConfig({...productionValues, appUrl: "http://playlistsyncer.com"}), "website", true).errors).toHaveLength(1)
        expect(checkStartupConfig(parseServerConfig({...productionValues, appUrl: "https://127.0.0.1:3007"}), "website", true).errors).toHaveLength(1)
    })

    test("rejects app URLs on private, loopback, link-local, or unspecified addresses", () => {
        const errorsFor = (appUrl: string) => checkStartupConfig(parseServerConfig({...productionValues, appUrl}), "website", true).errors
        const nonPublic = [
            "https://0.0.0.0",
            "https://10.1.2.3",
            "https://100.64.0.1",
            "https://127.0.0.2",
            "https://169.254.169.254",
            "https://172.16.0.1",
            "https://172.31.255.255",
            "https://192.168.1.1",
            "https://0xc0.0xa8.1.1",
            "https://app.localhost",
            "https://[::]",
            "https://[::1]",
            "https://[fd12::1]",
            "https://[fe80::1]",
            "https://[::ffff:192.168.1.1]"
        ]

        for (const appUrl of nonPublic) {
            expect(errorsFor(appUrl)).toEqual([expect.stringContaining("PLS_APP_URL must be the public https origin")])
        }
        for (const appUrl of ["https://playlistsyncer.com", "https://8.8.8.8", "https://172.32.0.1", "https://[2001:4860::8888]"]) {
            expect(errorsFor(appUrl)).toEqual([])
        }
    })

    test("accepts a complete production configuration and warns when SMTP is missing", () => {
        const website = checkStartupConfig(parseServerConfig(productionValues), "website", true)
        const jobs = checkStartupConfig(parseServerConfig(productionValues), "jobs", true)

        expect(website.errors).toEqual([])
        expect(jobs.errors).toEqual([])
        expect(website.warnings).toEqual([expect.stringContaining("SoundCloud users")])
        expect(jobs.warnings).toEqual([expect.stringContaining("weekly sync summaries")])
        expect(checkStartupConfig(parseServerConfig({...productionValues, smtpHost: "smtp.example.com"}), "website", true).warnings).toEqual([])
    })

    test("rejects partial Creem billing in production and only warns in development", () => {
        const partial = parseServerConfig({...productionValues, creemApiKey: "creem_key", creemProProductId: "prod_123", smtpHost: "smtp.example.com"})

        expect(checkStartupConfig(partial, "website", true).errors).toEqual(["Creem billing is partially configured; also set PLS_CREEM_WEBHOOK_SECRET"])
        expect(checkStartupConfig(partial, "website", false)).toEqual({errors: [], warnings: ["Creem billing is partially configured; also set PLS_CREEM_WEBHOOK_SECRET"]})
        expect(checkStartupConfig(parseServerConfig({}), "website", false)).toEqual({errors: [], warnings: []})
    })

    test("warns when production billing explicitly uses the Creem sandbox", () => {
        const creem = {creemApiKey: "creem_key", creemProProductId: "prod_123", creemWebhookSecret: "whsec", smtpHost: "smtp.example.com"}

        expect(checkStartupConfig(parseServerConfig({...productionValues, ...creem, creemServer: "test"}), "website", true)).toEqual({errors: [], warnings: ["PLS_CREEM_SERVER is test; checkout uses the Creem sandbox"]})
        expect(checkStartupConfig(parseServerConfig({...productionValues, ...creem, creemServer: "prod"}), "website", true)).toEqual({errors: [], warnings: []})
    })

    test("defaults the Creem server to prod only in production", () => {
        const environment = {NODE_ENV: process.env.NODE_ENV, PLS_CREEM_SERVER: process.env.PLS_CREEM_SERVER}
        try {
            delete process.env.PLS_CREEM_SERVER
            process.env.NODE_ENV = "production"
            clearServerConfigCache()
            expect(getServerConfig().creemServer).toBe("prod")
            process.env.NODE_ENV = "development"
            clearServerConfigCache()
            expect(getServerConfig().creemServer).toBe("test")
            process.env.PLS_CREEM_SERVER = "test"
            process.env.NODE_ENV = "production"
            clearServerConfigCache()
            expect(getServerConfig().creemServer).toBe("test")
        } finally {
            for (const [name, value] of Object.entries(environment)) {
                if (value === undefined) delete process.env[name]
                else process.env[name] = value
            }
            clearServerConfigCache()
        }
    })

    test("parses the shutdown timeout in seconds", () => {
        expect(parseServerConfig({}).shutdownTimeoutSeconds).toBe(8)
        expect(parseServerConfig({shutdownTimeoutSeconds: "110"}).shutdownTimeoutSeconds).toBe(110)
        expect(() => parseServerConfig({shutdownTimeoutSeconds: "0"})).toThrow()
    })

    test("parses PLS_SAFE_MODE as a boolean flag", () => {
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

    test("resolves PLS_SAFE_MODE for the public header flag", () => {
        expect(resolvePublicSafeMode({})).toBe(false)
        expect(resolvePublicSafeMode({PLS_SAFE_MODE: "true"})).toBe(true)
        expect(resolvePublicSafeMode({PLS_SAFE_MODE: "false"}, true)).toBe(false)
        expect(isPublicSafeMode(true)).toBe(true)
        expect(isPublicSafeMode("true")).toBe(true)
        expect(isPublicSafeMode("false")).toBe(false)
        expect(parseBooleanEnvFlag("maybe")).toBeUndefined()
    })
})
