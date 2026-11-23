import {randomUUID} from "node:crypto"
import {z} from "zod"
import {applyServerConfig, getEnvironmentConfig, isPublicAppOrigin, parseServerConfig} from "./config"
import {getDatabase} from "./database"
import logger from "./logger"
import {decryptSecret, encryptSecret} from "./secrets"

export const settingGroups = [
    {label: "Spotify", fields: {spotifyCredentials: {label: "App credentials", secret: true, hint: "Comma-separated client ID:secret pairs"}, spotifyMaxUsersPerApp: {label: "Maximum users per app"}}},
    {label: "YouTube Music", fields: {googleClientId: {label: "Google client ID"}, googleClientSecret: {label: "Google client secret", secret: true}}},
    {label: "Amazon Music", fields: {amazonClientId: {label: "Client ID"}, amazonClientSecret: {label: "Client secret", secret: true}, amazonMusicApiBaseUrl: {label: "API base URL"}}},
    {label: "TIDAL", fields: {tidalClientId: {label: "Client ID"}, tidalClientSecret: {label: "Client secret", secret: true}}},
    {label: "SoundCloud", fields: {soundcloudClientId: {label: "Client ID"}, soundcloudClientSecret: {label: "Client secret", secret: true}}},
    {
        label: "Apple Music",
        fields: {
            appleTeamId: {label: "Team ID"},
            appleClientId: {label: "Client ID"},
            appleSigninKeyId: {label: "Sign-in key ID"},
            appleSigninPrivateKey: {label: "Sign-in private key", secret: true, hint: "PEM text, or a single line with escaped newlines"}
        }
    },
    {
        label: "SMTP",
        fields: {smtpHost: {label: "Host"}, smtpPort: {label: "Port"}, smtpUser: {label: "Username"}, smtpPassword: {label: "Password", secret: true}, smtpFrom: {label: "From address"}}
    },
    {
        label: "Application",
        fields: {
            appUrl: {label: "Public site origin"},
            syncIntervalMinutes: {label: "Sync interval (minutes)"},
            safeMode: {label: "Safe mode", hint: "true or false"},
            extensionRedirectUris: {label: "Extension redirect URIs", hint: "Comma-separated HTTPS URLs"},
            userWebhookUrls: {label: "User event webhook URLs", secret: true, hint: "Comma-separated HTTP or HTTPS URLs"},
            shutdownTimeoutSeconds: {label: "Shutdown timeout (seconds)"}
        }
    },
    {
        label: "Rate limits",
        fields: {
            spotifyMaxRequestsPerMinute: {label: "Spotify requests per minute"},
            youtubeMaxRequestsPerMinute: {label: "YouTube Music requests per minute"},
            tidalMaxRequestsPerMinute: {label: "TIDAL requests per minute"},
            soundcloudMaxRequestsPerMinute: {label: "SoundCloud requests per minute"},
            appleMaxRequestsPerMinute: {label: "Apple Music requests per minute"},
            amazonMaxRequestsPerMinute: {label: "Amazon Music requests per minute"},
            userProviderRequestsPerMinute: {label: "Provider requests per user per minute"}
        }
    }
] as const satisfies readonly {label: string; fields: Partial<Record<keyof ReturnType<typeof getEnvironmentConfig>, {label: string; secret?: boolean; hint?: string}>>}[]

type FieldKeys<T> = T extends {fields: infer Fields} ? keyof Fields : never
type SettingKey = FieldKeys<(typeof settingGroups)[number]>
const settingKeys = settingGroups.flatMap(({fields}) => Object.keys(fields)) as SettingKey[]
const settingsSchema = z.partialRecord(z.enum(settingKeys), z.string())
export const settingsUpdateSchema = z.strictObject({
    revision: z.uuid(),
    changes: z.partialRecord(z.enum(settingKeys), z.string().max(16_384).nullable()).refine((changes) => Object.keys(changes).length > 0)
})
type Settings = z.infer<typeof settingsSchema>
type SettingsUpdate = z.infer<typeof settingsUpdateSchema>

interface SettingsDocument {
    _id: string
    revision: string
    encrypted: Awaited<ReturnType<typeof encryptSecret>>
}

const settingsId = "application"

export class InvalidRuntimeSettings extends Error {
    constructor(readonly fields: string[]) {
        super("Invalid application settings")
    }
}

export class StaleRuntimeSettings extends Error {}

export function mergeRuntimeSettings(values: Settings, environment = getEnvironmentConfig()) {
    const merged = {...environment, ...values}
    try {
        const config = parseServerConfig(merged)
        if (process.env.NODE_ENV === "production" && !isPublicAppOrigin(config.appUrl)) throw new InvalidRuntimeSettings(["appUrl"])
        return config
    } catch (error) {
        if (error instanceof z.ZodError) throw new InvalidRuntimeSettings([...new Set(error.issues.map(({path}) => String(path[0])))])
        throw error
    }
}

function settingsEncryptionKey() {
    const key = getEnvironmentConfig().tokenEncryptionKey
    if (!key) throw new Error("PLS_TOKEN_ENCRYPTION_KEY is required for database settings")
    return `playlistsyncer:settings:v1:${key}`
}

async function settingsCollection() {
    return (await getDatabase()).collection<SettingsDocument>("applicationSettings")
}

async function readSettingsDocument() {
    const key = settingsEncryptionKey()
    const collection = await settingsCollection()
    const existing = await collection.findOne({_id: settingsId})
    if (existing) return existing

    const environment = getEnvironmentConfig()
    const values: Settings = {}
    for (const name of settingKeys) {
        if (environment[name] !== undefined) values[name] = environment[name]
    }
    mergeRuntimeSettings(values, environment)
    const encrypted = await encryptSecret(JSON.stringify(values), key)
    try {
        const seeded = await collection.findOneAndUpdate({_id: settingsId}, {$setOnInsert: {revision: randomUUID(), encrypted}}, {upsert: true, returnDocument: "after"})
        if (seeded) return seeded
    } catch (error) {
        if (typeof error !== "object" || !error || !("code" in error) || error.code !== 11000) throw error
    }
    const seeded = await collection.findOne({_id: settingsId})
    if (!seeded) throw new Error("Application settings could not be initialized")
    return seeded
}

async function decodeSettings(document: SettingsDocument): Promise<Settings> {
    const values: unknown = JSON.parse(await decryptSecret(document.encrypted, settingsEncryptionKey()))
    const parsed = settingsSchema.safeParse(values)
    if (!parsed.success) throw new Error("Invalid stored application settings")
    return parsed.data
}

export async function readRuntimeSettings() {
    const document = await readSettingsDocument()
    return {revision: document.revision, values: await decodeSettings(document)}
}

export async function updateRuntimeSettings({revision, changes}: SettingsUpdate) {
    const current = await readRuntimeSettings()
    if (current.revision !== revision) throw new StaleRuntimeSettings()
    for (const name of settingKeys) {
        const value = changes[name]
        if (value === null) delete current.values[name]
        else if (value !== undefined) current.values[name] = value
    }
    const config = mergeRuntimeSettings(current.values)
    const encrypted = await encryptSecret(JSON.stringify(current.values), settingsEncryptionKey())
    const nextRevision = randomUUID()
    const collection = await settingsCollection()
    const result = await collection.updateOne({_id: settingsId, revision}, {$set: {revision: nextRevision, encrypted}})
    if (!result.matchedCount) throw new StaleRuntimeSettings()
    applyServerConfig(config)
    return {revision: nextRevision, values: current.values}
}

export let runtimeSettingsReady = Promise.resolve()

// Refresh between requests and job runs, keeping the last validated snapshot after transient failures.
export function watchRuntimeSettings() {
    let revision: string | undefined
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
        const document = await readSettingsDocument()
        if (stopped || document.revision === revision) return
        const config = mergeRuntimeSettings(await decodeSettings(document))
        if (!stopped) {
            applyServerConfig(config)
            revision = document.revision
        }
    }
    function schedule() {
        if (stopped) return
        timer = setTimeout(() => {
            void refresh()
                .then(() => {
                    if (revision) runtimeSettingsReady = Promise.resolve()
                })
                .catch(() => logger.warn("Settings.refresh", "Could not refresh application settings; retaining the last validated settings"))
                .finally(schedule)
        }, 10_000)
        timer.unref()
    }
    const ready = getEnvironmentConfig().tokenEncryptionKey ? refresh().finally(schedule) : Promise.resolve()
    runtimeSettingsReady = ready
    return {
        ready,
        stop: () => {
            stopped = true
            clearTimeout(timer)
        }
    }
}
