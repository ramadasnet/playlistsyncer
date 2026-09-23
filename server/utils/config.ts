// Parse and cache configuration from environment variables.

import {z} from "zod"
import {parseBooleanEnvFlag} from "../../shared/env-flag"
import {defaultProSyncIntervalMinutes} from "../../shared/sync-cadence"

const optionalCredential = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional())
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
const optionalPort = z.preprocess((value) => (value === "" || value === undefined || value === null ? 587 : value), z.coerce.number().int().min(1).max(65535))
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
    .default("http://localhost:3007")

const serverConfigSchema = z.object({
    appUrl,
    mongodbUri: optionalCredential,
    mongodbDatabase: z.string().min(1).default("playlistsync"),
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
    spotifyMaxRequestsPerMinute: requestsPerMinute(120),
    youtubeMaxRequestsPerMinute: requestsPerMinute(300),
    tidalMaxRequestsPerMinute: requestsPerMinute(60),
    amazonMaxRequestsPerMinute: requestsPerMinute(60),
    creemApiKey: optionalCredential,
    creemWebhookSecret: optionalCredential,
    creemProProductId: optionalCredential,
    creemServer: z.enum(["test", "prod"]).default("test"),
    developmentProUserEmails: emailList,
    proSubscriptionRequiredAt: optionalInstant,
    proSyncIntervalMinutes: z.coerce.number().int().min(1).default(defaultProSyncIntervalMinutes),
    smtpHost: optionalCredential,
    smtpPort: optionalPort,
    smtpUser: optionalCredential,
    smtpPassword: optionalCredential,
    smtpFrom: optionalCredential,
    safeMode: booleanFlag
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

// Validate raw configuration values and apply documented defaults.
export function parseServerConfig(values: Record<string, unknown>): ServerConfig {
    return serverConfigSchema.parse(values)
}

// Resolve the public application URL from supported environment names.
export function resolveAppUrl(environment: Record<string, string | undefined>): string | undefined {
    return environment.PLS_APP_URL
}

let cachedConfig: ServerConfig | undefined

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
            spotifyMaxRequestsPerMinute: process.env.PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE,
            youtubeMaxRequestsPerMinute: process.env.PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE,
            tidalMaxRequestsPerMinute: process.env.PLS_TIDAL_MAX_REQUESTS_PER_MINUTE,
            amazonMaxRequestsPerMinute: process.env.PLS_AMAZON_MAX_REQUESTS_PER_MINUTE,
            creemApiKey: process.env.PLS_CREEM_API_KEY,
            creemWebhookSecret: process.env.PLS_CREEM_WEBHOOK_SECRET,
            creemProProductId: process.env.PLS_CREEM_PRO_PRODUCT_ID,
            creemServer: process.env.PLS_CREEM_SERVER,
            developmentProUserEmails: process.env.PLS_DEVELOPMENT_PRO_USER_EMAILS,
            proSubscriptionRequiredAt: process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT,
            proSyncIntervalMinutes: process.env.PLS_TASKSYNC_INTERVAL,
            smtpHost: process.env.PLS_SMTP_HOST,
            smtpPort: process.env.PLS_SMTP_PORT,
            smtpUser: process.env.PLS_SMTP_USER,
            smtpPassword: process.env.PLS_SMTP_PASSWORD,
            smtpFrom: process.env.PLS_SMTP_FROM,
            safeMode: process.env.PLS_SAFE_MODE
        })
    }

    return cachedConfig
}

// Return a required setting or fail with a service-unavailable response.
export function requireConfig<K extends keyof ServerConfig>(key: K): NonNullable<ServerConfig[K]> {
    const value = getServerConfig()[key]
    if (!value) {
        throw createError({statusCode: 503, statusMessage: `Missing required configuration: ${key}`})
    }
    return value as NonNullable<ServerConfig[K]>
}
