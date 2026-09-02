import {z} from "zod"

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
    creemApiKey: optionalCredential,
    creemWebhookSecret: optionalCredential,
    creemProProductId: optionalCredential,
    creemServer: z.enum(["test", "prod"]).default("test"),
    developmentProUserEmails: emailList
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

export function parseServerConfig(values: Record<string, unknown>): ServerConfig {
    return serverConfigSchema.parse(values)
}

export function resolveAppUrl(environment: Record<string, string | undefined>): string | undefined {
    return environment.APP_URL || environment.NUXT_PUBLIC_SITE_URL
}

let cachedConfig: ServerConfig | undefined

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
            creemApiKey: process.env.CREEM_API_KEY,
            creemWebhookSecret: process.env.CREEM_WEBHOOK_SECRET,
            creemProProductId: process.env.CREEM_PRO_PRODUCT_ID,
            creemServer: process.env.CREEM_SERVER,
            developmentProUserEmails: process.env.DEVELOPMENT_PRO_USER_EMAILS
        })
    }

    return cachedConfig
}

export function requireConfig<K extends keyof ServerConfig>(key: K): NonNullable<ServerConfig[K]> {
    const value = getServerConfig()[key]
    if (!value) {
        throw createError({statusCode: 503, statusMessage: `Missing required configuration: ${key}`})
    }
    return value as NonNullable<ServerConfig[K]>
}
