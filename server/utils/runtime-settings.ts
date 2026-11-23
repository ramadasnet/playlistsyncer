import {createHmac} from "node:crypto"
import {z} from "zod"
import {applyServerConfig, getEnvironmentConfig, isPublicAppOrigin, parseServerConfig, serverConfigKeys} from "./config"
import {infisicalFallback, readInfisicalSecrets, runtimeInfisicalConnection, saveInfisicalSecrets} from "./infisical"
import logger from "./logger"

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
    revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    changes: z.partialRecord(z.enum(settingKeys), z.string().max(16_384)).refine((changes) => Object.keys(changes).length > 0)
})
type Settings = z.infer<typeof settingsSchema>
type SettingsUpdate = z.infer<typeof settingsUpdateSchema>

export class InvalidRuntimeSettings extends Error {
    constructor(readonly fields: string[]) {
        super("Invalid application settings")
    }
}

export class StaleRuntimeSettings extends Error {}

function runtimeDefaults() {
    const fallback = Object.fromEntries(settingKeys.map((name) => [serverConfigKeys[name], infisicalFallback(serverConfigKeys[name])]))
    return getEnvironmentConfig({...process.env, ...fallback})
}

export function mergeRuntimeSettings(values: Settings, environment = runtimeDefaults()) {
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

export async function readRuntimeSettings(connection = runtimeInfisicalConnection()) {
    const values: Settings = {}
    if (!connection) return {revision: null, values}
    const secrets = await readInfisicalSecrets(connection)
    for (const name of settingKeys) {
        const value = secrets[serverConfigKeys[name]]
        if (value !== undefined) values[name] = value
    }
    const revision = Object.keys(values).length ? createHmac("sha256", connection.clientSecret).update(JSON.stringify(values)).digest("hex") : null
    return {revision, values}
}

let pendingUpdate = Promise.resolve()

export function updateRuntimeSettings({revision, changes}: SettingsUpdate) {
    const update = pendingUpdate.then(async () => {
        const connection = runtimeInfisicalConnection()
        if (!connection) throw new Error("Infisical is not configured")
        const current = await readRuntimeSettings(connection)
        if (current.revision !== revision) throw new StaleRuntimeSettings()

        const entries = Object.entries(changes) as [SettingKey, string][]
        const untrimmed = entries.filter(([, value]) => value.trim() !== value)
        if (untrimmed.length) throw new InvalidRuntimeSettings(untrimmed.map(([name]) => name))
        const previous = mergeRuntimeSettings(current.values)
        const next = mergeRuntimeSettings({...current.values, ...changes})
        if ((next.smtpHost !== previous.smtpHost || next.smtpPort !== previous.smtpPort) && next.smtpUser && next.smtpPassword && next.smtpPassword === previous.smtpPassword) {
            throw new InvalidRuntimeSettings(["smtpPassword"])
        }
        await saveInfisicalSecrets(Object.fromEntries(entries.map(([name, value]) => [serverConfigKeys[name], value])), connection)

        const saved = await readRuntimeSettings(connection)
        if (entries.some(([name, value]) => saved.values[name] !== value)) throw new Error("Saved settings are not yet visible in Infisical")
        applyServerConfig(mergeRuntimeSettings(saved.values))
        return saved
    })
    pendingUpdate = update.then(
        () => undefined,
        () => undefined
    )
    return update
}

export let runtimeSettingsReady = Promise.resolve()

// Refresh between requests and job runs, keeping the last validated snapshot after transient failures.
export function watchRuntimeSettings() {
    const connection = runtimeInfisicalConnection()
    let revision: string | null | undefined
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
        const {revision: nextRevision, values} = await readRuntimeSettings(connection)
        if (stopped || nextRevision === revision) return
        const config = mergeRuntimeSettings(values)
        if (!stopped) {
            applyServerConfig(config)
            revision = nextRevision
        }
    }
    function schedule() {
        if (stopped) return
        timer = setTimeout(() => {
            void refresh()
                .then(() => {
                    if (revision !== undefined) runtimeSettingsReady = Promise.resolve()
                })
                .catch(() => logger.warn("Settings.refresh", "Could not refresh application settings; retaining the last validated settings"))
                .finally(schedule)
        }, 10_000)
        timer.unref()
    }
    const ready = connection ? refresh().finally(schedule) : Promise.resolve()
    runtimeSettingsReady = ready
    return {
        ready,
        stop: () => {
            stopped = true
            clearTimeout(timer)
        }
    }
}
