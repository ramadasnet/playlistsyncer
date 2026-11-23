// Parse and cache configuration from environment variables.

import {BlockList, isIP} from "node:net"
import {z} from "zod"
import {resolveAppUrl} from "../../shared/app-url"
import {parseBooleanEnvFlag} from "../../shared/env-flag"
import {defaultSyncIntervalMinutes} from "../../shared/sync-cadence"
import logger from "./logger"

export {resolveAppUrl} from "../../shared/app-url"

const optionalCredential = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional())
// A PEM key kept on one line in .env or a secret store uses literal \n separators.
const optionalPrivateKey = optionalCredential.transform((value) => value?.replace(/\\n/g, "\n"))
// Exact redirect URIs of the published browser extensions, such as https://<extension-id>.chromiumapp.org/.
const urlList = z.preprocess(
    (value) =>
        typeof value === "string"
            ? value
                  .split(",")
                  .map((url) => url.trim())
                  .filter(Boolean)
            : value,
    z.array(z.url({protocol: /^https$/})).default([])
)
// User event webhooks may point at internal receivers, so plain http is allowed.
const webhookUrlList = z.preprocess(
    (value) =>
        typeof value === "string"
            ? value
                  .split(",")
                  .map((url) => url.trim())
                  .filter(Boolean)
            : value,
    z.array(z.url({protocol: /^https?$/})).default([])
)
// Spotify app credentials as clientId:clientSecret pairs, comma-separated and in selection order.
const spotifyCredentialPairs = z.preprocess(
    (value) =>
        typeof value === "string"
            ? value
                  .split(",")
                  .map((pair) => pair.trim())
                  .filter(Boolean)
                  .map((pair) => {
                      const separator = pair.indexOf(":")
                      return {clientId: pair.slice(0, separator < 0 ? undefined : separator).trim(), clientSecret: (separator < 0 ? "" : pair.slice(separator + 1)).trim()}
                  })
            : value,
    z.array(z.object({clientId: z.string().min(1), clientSecret: z.string().min(1)})).default([])
)
const optionalPort = z.preprocess((value) => (value === "" || value === undefined || value === null ? 465 : value), z.coerce.number().int().min(1).max(65535))
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
    spotifyCredentials: spotifyCredentialPairs,
    spotifyMaxUsersPerApp: z.preprocess((value) => (value === "" || value === undefined || value === null ? 5 : value), z.coerce.number().int().min(1)),
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
    syncIntervalMinutes: z.coerce.number().int().min(1).default(defaultSyncIntervalMinutes),
    smtpHost: optionalCredential.default("smtp.mx.cloudflare.net"),
    smtpPort: optionalPort,
    smtpUser: optionalCredential.default("api_token"),
    smtpPassword: optionalCredential,
    smtpFrom: optionalCredential,
    safeMode: booleanFlag,
    extensionRedirectUris: urlList,
    userWebhookUrls: webhookUrlList,
    // Seconds a stopping process waits for in-flight sync runs; keep it below the container's stop grace period.
    shutdownTimeoutSeconds: z.coerce.number().int().min(1).default(8)
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

// Validate raw configuration values and apply documented defaults.
export function parseServerConfig(values: Record<string, unknown>): ServerConfig {
    return serverConfigSchema.parse(values)
}

let cachedConfig: ServerConfig | undefined

export function applyServerConfig(config: ServerConfig): void {
    cachedConfig = config
}

// Drop the cached configuration so a test can observe environment changes.
export function clearServerConfigCache(): void {
    cachedConfig = undefined
}

export const serverConfigKeys = {
    appUrl: "PLS_APP_URL",
    mongodbUri: "PLS_MONGODB_URI",
    mongodbDatabase: "PLS_MONGODB_DATABASE",
    sessionSecret: "PLS_SESSION_SECRET",
    tokenEncryptionKey: "PLS_TOKEN_ENCRYPTION_KEY",
    schedulerSecret: "PLS_SCHEDULER_SECRET",
    spotifyCredentials: "PLS_SPOTIFY_CREDENTIALS",
    spotifyMaxUsersPerApp: "PLS_SPOTIFY_MAX_USERS_PER_APP",
    googleClientId: "PLS_GOOGLE_CLIENT_ID",
    googleClientSecret: "PLS_GOOGLE_CLIENT_SECRET",
    amazonClientId: "PLS_AMAZON_CLIENT_ID",
    amazonClientSecret: "PLS_AMAZON_CLIENT_SECRET",
    amazonMusicApiBaseUrl: "PLS_AMAZON_MUSIC_API_BASE_URL",
    tidalClientId: "PLS_TIDAL_CLIENT_ID",
    tidalClientSecret: "PLS_TIDAL_CLIENT_SECRET",
    soundcloudClientId: "PLS_SOUNDCLOUD_CLIENT_ID",
    soundcloudClientSecret: "PLS_SOUNDCLOUD_CLIENT_SECRET",
    appleTeamId: "PLS_APPLE_TEAM_ID",
    appleClientId: "PLS_APPLE_CLIENT_ID",
    appleSigninKeyId: "PLS_APPLE_SIGNIN_KEY_ID",
    appleSigninPrivateKey: "PLS_APPLE_SIGNIN_PRIVATE_KEY",
    spotifyMaxRequestsPerMinute: "PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE",
    youtubeMaxRequestsPerMinute: "PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE",
    tidalMaxRequestsPerMinute: "PLS_TIDAL_MAX_REQUESTS_PER_MINUTE",
    soundcloudMaxRequestsPerMinute: "PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE",
    appleMaxRequestsPerMinute: "PLS_APPLE_MAX_REQUESTS_PER_MINUTE",
    amazonMaxRequestsPerMinute: "PLS_AMAZON_MAX_REQUESTS_PER_MINUTE",
    userProviderRequestsPerMinute: "PLS_USER_PROVIDER_REQUESTS_PER_MINUTE",
    syncIntervalMinutes: "PLS_TASKSYNC_INTERVAL",
    smtpHost: "PLS_SMTP_HOST",
    smtpPort: "PLS_SMTP_PORT",
    smtpUser: "PLS_SMTP_USER",
    smtpPassword: "PLS_SMTP_PASSWORD",
    smtpFrom: "PLS_SMTP_FROM",
    safeMode: "PLS_SAFE_MODE",
    extensionRedirectUris: "PLS_EXTENSION_REDIRECT_URIS",
    userWebhookUrls: "PLS_USER_WEBHOOK_URLS",
    shutdownTimeoutSeconds: "PLS_SHUTDOWN_TIMEOUT_SECONDS"
} as const

// Read the deployment defaults before applying Infisical settings.
export function getEnvironmentConfig(env: Record<string, string | undefined> = process.env) {
    const entries = Object.entries(serverConfigKeys).map(([field, name]) => [field, env[name]])
    const values = Object.fromEntries(entries) as Record<keyof typeof serverConfigKeys, string | undefined>
    return {...values, appUrl: resolveAppUrl(env)}
}

// Keep synchronous consumers on the last validated configuration.
export function getServerConfig(): ServerConfig {
    return (cachedConfig ??= parseServerConfig(getEnvironmentConfig()))
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

export function isPublicAppOrigin(origin: string): boolean {
    const url = new URL(origin)
    return url.protocol === "https:" && !isNonPublicHostname(url.hostname)
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
    if (!isPublicAppOrigin(config.appUrl)) {
        errors.push(`PLS_APP_URL must be the public https origin, not ${config.appUrl}`)
    }
    if (!config.smtpHost) {
        warnings.push(
            role === "website"
                ? "PLS_SMTP_HOST is not set; no email is sent, so users whose provider shares no email (all SoundCloud users) cannot confirm one or enable weekly summaries"
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
