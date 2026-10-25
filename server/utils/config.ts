// Parse and cache configuration from environment variables.

import {BlockList, isIP} from "node:net"
import {z} from "zod"
import {resolveAppUrl} from "../../shared/app-url"
import {parseBooleanEnvFlag} from "../../shared/env-flag"
import {defaultProSyncIntervalMinutes} from "../../shared/sync-cadence"
import logger from "./logger"

export {resolveAppUrl} from "../../shared/app-url"

const optionalCredential = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional())
// A PEM key kept on one line in .env or a secret store uses literal \n separators.
const optionalPrivateKey = optionalCredential.transform((value) => value?.replace(/\\n/g, "\n"))
const emailList = z.preprocess(
    (value) =>
        typeof value === "string"
            ? value
                  .split(",")
                  .map((email) => email.trim())
                  .filter(Boolean)
            : value,
    z.array(z.email().transform((email) => email.toLowerCase())).default([])
)
const optionalPort = z.preprocess((value) => (value === "" || value === undefined || value === null ? 465 : value), z.coerce.number().int().min(1).max(65535))
const optionalInstant = z.preprocess((value) => {
    if (value === "" || value === undefined || value === null) {
        return undefined
    }
    const parsed = value instanceof Date ? value : new Date(String(value))
    if (Number.isNaN(parsed.getTime())) {
        return value
    }
    return parsed
}, z.date().optional())
const booleanFlag = z.preprocess((value) => {
    const parsed = parseBooleanEnvFlag(value)
    return parsed === undefined ? value : parsed
}, z.boolean().default(false))
// Requests per minute allowed for a provider API; 0 disables pacing but keeps the rate limit cooldown.
const requestsPerMinute = (fallback: number) => z.preprocess((value) => (value === "" || value === undefined || value === null ? fallback : value), z.coerce.number().int().min(0))
const appUrl = z
    .string()
    .url()
    .refine((value) => new URL(value).pathname === "/" && !new URL(value).search && !new URL(value).hash, {
        message: "PLS_APP_URL must contain only an origin"
    })
    .transform((value) => new URL(value).origin)
    .prefault(() => resolveAppUrl({NODE_ENV: process.env.NODE_ENV}))

const serverConfigSchema = z.object({
    appUrl,
    mongodbUri: optionalCredential,
    mongodbDatabase: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).default("playlistsyncer")),
    sessionSecret: optionalCredential,
    tokenEncryptionKey: optionalCredential,
    schedulerSecret: optionalCredential,
    spotifyClientId: optionalCredential,
    spotifyClientSecret: optionalCredential,
    googleClientId: optionalCredential,
    googleClientSecret: optionalCredential,
    amazonClientId: optionalCredential,
    amazonClientSecret: optionalCredential,
    amazonMusicApiBaseUrl: optionalCredential,
    tidalClientId: optionalCredential,
    tidalClientSecret: optionalCredential,
    soundcloudClientId: optionalCredential,
    soundcloudClientSecret: optionalCredential,
    appleTeamId: optionalCredential,
    appleClientId: optionalCredential,
    appleSigninKeyId: optionalCredential,
    appleSigninPrivateKey: optionalPrivateKey,
    spotifyMaxRequestsPerMinute: requestsPerMinute(120),
    youtubeMaxRequestsPerMinute: requestsPerMinute(300),
    tidalMaxRequestsPerMinute: requestsPerMinute(60),
    soundcloudMaxRequestsPerMinute: requestsPerMinute(60),
    appleMaxRequestsPerMinute: requestsPerMinute(120),
    amazonMaxRequestsPerMinute: requestsPerMinute(60),
    userProviderRequestsPerMinute: requestsPerMinute(40),
    creemApiKey: optionalCredential,
    creemWebhookSecret: optionalCredential,
    creemProProductId: optionalCredential,
    creemServer: z.enum(["test", "prod"]).default("test"),
    developmentProUserEmails: emailList,
    proSubscriptionRequiredAt: optionalInstant,
    proSyncIntervalMinutes: z.coerce.number().int().min(1).default(defaultProSyncIntervalMinutes),
    smtpHost: optionalCredential.default("smtp.mx.cloudflare.net"),
    smtpPort: optionalPort,
    smtpUser: optionalCredential.default("api_token"),
    smtpPassword: optionalCredential,
    smtpFrom: optionalCredential,
    safeMode: booleanFlag,
    // Seconds a stopping process waits for in-flight sync runs; keep it below the container's stop grace period.
    shutdownTimeoutSeconds: z.coerce.number().int().min(1).default(8)
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

// Validate raw configuration values and apply documented defaults.
export function parseServerConfig(values: Record<string, unknown>): ServerConfig {
    return serverConfigSchema.parse(values)
}

let cachedConfig: ServerConfig | undefined

// Drop the cached configuration so a test can observe environment changes.
export function clearServerConfigCache(): void {
    cachedConfig = undefined
}

// Load configuration once so every request observes the same validated values.
export function getServerConfig(): ServerConfig {
    if (!cachedConfig) {
        cachedConfig = parseServerConfig({
            appUrl: resolveAppUrl(process.env),
            mongodbUri: process.env.PLS_MONGODB_URI,
            mongodbDatabase: process.env.PLS_MONGODB_DATABASE,
            sessionSecret: process.env.PLS_SESSION_SECRET,
            tokenEncryptionKey: process.env.PLS_TOKEN_ENCRYPTION_KEY,
            schedulerSecret: process.env.PLS_SCHEDULER_SECRET,
            spotifyClientId: process.env.PLS_SPOTIFY_CLIENT_ID,
            spotifyClientSecret: process.env.PLS_SPOTIFY_CLIENT_SECRET,
            googleClientId: process.env.PLS_GOOGLE_CLIENT_ID,
            googleClientSecret: process.env.PLS_GOOGLE_CLIENT_SECRET,
            amazonClientId: process.env.PLS_AMAZON_CLIENT_ID,
            amazonClientSecret: process.env.PLS_AMAZON_CLIENT_SECRET,
            amazonMusicApiBaseUrl: process.env.PLS_AMAZON_MUSIC_API_BASE_URL,
            tidalClientId: process.env.PLS_TIDAL_CLIENT_ID,
            tidalClientSecret: process.env.PLS_TIDAL_CLIENT_SECRET,
            soundcloudClientId: process.env.PLS_SOUNDCLOUD_CLIENT_ID,
            soundcloudClientSecret: process.env.PLS_SOUNDCLOUD_CLIENT_SECRET,
            appleTeamId: process.env.PLS_APPLE_TEAM_ID,
            appleClientId: process.env.PLS_APPLE_CLIENT_ID,
            appleSigninKeyId: process.env.PLS_APPLE_SIGNIN_KEY_ID,
            appleSigninPrivateKey: process.env.PLS_APPLE_SIGNIN_PRIVATE_KEY,
            spotifyMaxRequestsPerMinute: process.env.PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE,
            youtubeMaxRequestsPerMinute: process.env.PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE,
            tidalMaxRequestsPerMinute: process.env.PLS_TIDAL_MAX_REQUESTS_PER_MINUTE,
            soundcloudMaxRequestsPerMinute: process.env.PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE,
            appleMaxRequestsPerMinute: process.env.PLS_APPLE_MAX_REQUESTS_PER_MINUTE,
            amazonMaxRequestsPerMinute: process.env.PLS_AMAZON_MAX_REQUESTS_PER_MINUTE,
            userProviderRequestsPerMinute: process.env.PLS_USER_PROVIDER_REQUESTS_PER_MINUTE,
            creemApiKey: process.env.PLS_CREEM_API_KEY,
            creemWebhookSecret: process.env.PLS_CREEM_WEBHOOK_SECRET,
            creemProProductId: process.env.PLS_CREEM_PRO_PRODUCT_ID,
            // Production bills live unless the sandbox is chosen explicitly.
            creemServer: process.env.PLS_CREEM_SERVER || (process.env.NODE_ENV === "production" ? "prod" : "test"),
            developmentProUserEmails: process.env.PLS_DEVELOPMENT_PRO_USER_EMAILS,
            proSubscriptionRequiredAt: process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT,
            proSyncIntervalMinutes: process.env.PLS_TASKSYNC_INTERVAL,
            smtpHost: process.env.PLS_SMTP_HOST,
            smtpPort: process.env.PLS_SMTP_PORT,
            smtpUser: process.env.PLS_SMTP_USER,
            smtpPassword: process.env.PLS_SMTP_PASSWORD,
            smtpFrom: process.env.PLS_SMTP_FROM,
            safeMode: process.env.PLS_SAFE_MODE,
            shutdownTimeoutSeconds: process.env.PLS_SHUTDOWN_TIMEOUT_SECONDS
        })
    }

    return cachedConfig
}

// Unspecified, private, shared (CGNAT), loopback, and link-local ranges cannot be a public origin.
const nonPublicAddresses = new BlockList()
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16]
] as const) {
    nonPublicAddresses.addSubnet(address, prefix, "ipv4")
}
for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10]
] as const) {
    nonPublicAddresses.addSubnet(address, prefix, "ipv6")
}

// Whether a URL hostname (already normalized by URL) names this machine or a non-public network.
function isNonPublicHostname(hostname: string): boolean {
    // URL keeps one trailing dot, so localhost. is still the loopback name.
    const dnsName = hostname.replace(/\.$/, "")
    if (dnsName === "localhost" || dnsName.endsWith(".localhost")) {
        return true
    }
    const address = hostname.replace(/^\[|\]$/g, "")
    const version = isIP(address)
    // IPv4-mapped IPv6 is rejected outright; Bun's BlockList would match every IPv4 address against a mapped range.
    if (version === 6 && address.startsWith("::ffff:")) {
        return true
    }
    return version !== 0 && nonPublicAddresses.check(address, version === 6 ? "ipv6" : "ipv4")
}

/**
 * Lists configuration problems for one process before it starts serving.
 * @param config Parsed server configuration.
 * @param role Process being started; the website needs sessions, the jobs process needs the scheduler secret.
 * @param production Whether this is a production start, where errors must stop the process.
 * @returns Errors that block a production start, and warnings that are only logged.
 */
export function checkStartupConfig(config: ServerConfig, role: "website" | "jobs", production = process.env.NODE_ENV === "production"): {errors: string[]; warnings: string[]} {
    const errors: string[] = []
    const warnings: string[] = []
    const creem = {PLS_CREEM_API_KEY: config.creemApiKey, PLS_CREEM_PRO_PRODUCT_ID: config.creemProProductId, PLS_CREEM_WEBHOOK_SECRET: config.creemWebhookSecret}
    const missingCreem = Object.keys(creem).filter((name) => !creem[name as keyof typeof creem])
    // A partial Creem setup takes payments that the webhook can never turn into PRO access.
    if (missingCreem.length && missingCreem.length < Object.keys(creem).length) {
        const problems = production ? errors : warnings
        problems.push(`Creem billing is partially configured; also set ${missingCreem.join(", ")}`)
    }
    if (!production) {
        return {errors, warnings}
    }

    const required = {
        PLS_MONGODB_URI: config.mongodbUri,
        PLS_TOKEN_ENCRYPTION_KEY: config.tokenEncryptionKey,
        ...(role === "website" ? {PLS_SESSION_SECRET: config.sessionSecret} : {PLS_SCHEDULER_SECRET: config.schedulerSecret})
    }
    for (const [name, value] of Object.entries(required)) {
        if (!value) errors.push(`${name} is required`)
    }
    const appUrl = new URL(config.appUrl)
    if (appUrl.protocol !== "https:" || isNonPublicHostname(appUrl.hostname)) {
        errors.push(`PLS_APP_URL must be the public https origin, not ${config.appUrl}`)
    }
    if (config.creemApiKey && config.creemServer === "test") {
        warnings.push("PLS_CREEM_SERVER is test; checkout uses the Creem sandbox")
    }
    if (!config.smtpHost) {
        warnings.push(
            role === "website"
                ? "PLS_SMTP_HOST is not set; no email is sent, so users whose provider shares no email (all SoundCloud users) cannot confirm one, subscribe to PRO, or enable weekly summaries"
                : "PLS_SMTP_HOST is not set; weekly sync summaries are not sent"
        )
    }
    return {errors, warnings}
}

// Log startup configuration warnings, and throw when this process must not start.
export function assertStartupConfig(role: "website" | "jobs"): void {
    const {errors, warnings} = checkStartupConfig(getServerConfig(), role)
    for (const warning of warnings) {
        logger.warn("Config.startup", warning)
    }
    if (errors.length) {
        throw new Error(`Invalid production configuration: ${errors.join("; ")}`)
    }
}

// Return a required setting or fail with a service-unavailable response.
export function requireConfig<K extends keyof ServerConfig>(key: K): NonNullable<ServerConfig[K]> {
    const value = getServerConfig()[key]
    if (!value) {
        throw createError({statusCode: 503, statusMessage: `Missing required configuration: ${key}`})
    }
    return value as NonNullable<ServerConfig[K]>
}
