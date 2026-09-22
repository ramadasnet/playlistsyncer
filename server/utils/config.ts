// Parse and cache configuration from environment variables.

import {z} from "zod"
import {parseBooleanEnvFlag} from "../../shared/env-flag"
import {defaultProSyncIntervalHours} from "../../shared/sync-cadence"

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
        message: "APP_URL must contain only an origin"
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
    proSyncIntervalHours: z.coerce.number().int().min(1).default(defaultProSyncIntervalHours),
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
    return environment.APP_URL || environment.NUXT_PUBLIC_SITE_URL
}

let cachedConfig: ServerConfig | undefined

// Load configuration once so every request observes the same validated values.
export function getServerConfig(): ServerConfig {
    if (!cachedConfig) {
        cachedConfig = parseServerConfig({
            appUrl: resolveAppUrl(process.env),
            mongodbUri: process.env.MONGODB_URI,
            mongodbDatabase: process.env.MONGODB_DATABASE,
            sessionSecret: process.env.SESSION_SECRET,
            tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
            schedulerSecret: process.env.SCHEDULER_SECRET,
            spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
            spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            googleClientId: process.env.GOOGLE_CLIENT_ID,
            googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
            amazonClientId: process.env.AMAZON_CLIENT_ID,
            amazonClientSecret: process.env.AMAZON_CLIENT_SECRET,
            amazonMusicApiBaseUrl: process.env.AMAZON_MUSIC_API_BASE_URL,
            tidalClientId: process.env.TIDAL_CLIENT_ID,
            tidalClientSecret: process.env.TIDAL_CLIENT_SECRET,
            spotifyMaxRequestsPerMinute: process.env.SPOTIFY_MAX_REQUESTS_PER_MINUTE,
            youtubeMaxRequestsPerMinute: process.env.YOUTUBE_MAX_REQUESTS_PER_MINUTE,
            tidalMaxRequestsPerMinute: process.env.TIDAL_MAX_REQUESTS_PER_MINUTE,
            amazonMaxRequestsPerMinute: process.env.AMAZON_MAX_REQUESTS_PER_MINUTE,
            creemApiKey: process.env.CREEM_API_KEY,
            creemWebhookSecret: process.env.CREEM_WEBHOOK_SECRET,
            creemProProductId: process.env.CREEM_PRO_PRODUCT_ID,
            creemServer: process.env.CREEM_SERVER,
            developmentProUserEmails: process.env.DEVELOPMENT_PRO_USER_EMAILS,
            proSubscriptionRequiredAt: process.env.PRO_SUBSCRIPTION_REQUIRED_AT || process.env.NUXT_PUBLIC_PRO_SUBSCRIPTION_REQUIRED_AT,
            proSyncIntervalHours: process.env.PRO_SYNC_INTERVAL_HOURS,
            smtpHost: process.env.SMTP_HOST,
            smtpPort: process.env.SMTP_PORT,
            smtpUser: process.env.SMTP_USER,
            smtpPassword: process.env.SMTP_PASSWORD,
            smtpFrom: process.env.SMTP_FROM,
            safeMode: process.env.SAFE_MODE
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
