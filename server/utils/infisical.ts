import setmeup from "setmeup"

type Env = Record<string, string | undefined>
type SecretValues = Record<string, string>
type Connection = setmeup.InfisicalOptions & {clientId: string; clientSecret: string; projectId: string}

const preloadStateKey = Symbol.for("playlistsyncer.infisical.preload")
const state = globalThis as typeof globalThis & {[preloadStateKey]?: {fallback: Env; connection: Connection}}

function infisicalConnection(env: Env): Connection | undefined {
    const {PLS_INFISICAL_CLIENT_ID: clientId, PLS_INFISICAL_CLIENT_SECRET: clientSecret, PLS_INFISICAL_PROJECT_ID: projectId} = env
    if (!clientId) return undefined
    if (!clientSecret || !projectId) throw new Error("PLS_INFISICAL_CLIENT_SECRET and PLS_INFISICAL_PROJECT_ID are required when PLS_INFISICAL_CLIENT_ID is set")
    return {
        clientId,
        clientSecret,
        projectId,
        environment: env.PLS_INFISICAL_ENVIRONMENT || "prod",
        secretPath: env.PLS_INFISICAL_SECRET_PATH || "/",
        siteUrl: env.PLS_INFISICAL_SITE_URL || "https://app.infisical.com",
        expandSecretReferences: false
    }
}

export function runtimeInfisicalConnection() {
    return state[preloadStateKey]?.connection ?? infisicalConnection(process.env)
}

export function infisicalFallback(name: string) {
    const fallback = state[preloadStateKey]?.fallback
    return fallback && Object.hasOwn(fallback, name) ? fallback[name] : process.env[name]
}

function flatten(data: unknown, values: SecretValues, prefix = "") {
    if (!data || typeof data !== "object") return
    for (const [part, value] of Object.entries(data)) {
        const name = prefix + part
        if (typeof value === "string") values[name] = value
        else if (value && typeof value === "object") flatten(value, values, name + "_")
    }
}

export async function readInfisicalSecrets(connection: Connection): Promise<SecretValues> {
    const values: SecretValues = Object.create(null)
    try {
        flatten(await setmeup.newInstance().loadFromInfisical({...connection, rawValues: true}), values)
    } catch {
        throw new Error("Could not load Infisical secrets")
    }
    return values
}

export async function saveInfisicalSecrets(values: SecretValues, connection: Connection) {
    const nested: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(values)) {
        const parts = name.split("_")
        const key = parts.pop()!
        let target = nested
        for (const part of parts) target = (target[part] ??= {}) as Record<string, unknown>
        target[key] = value
    }
    try {
        await setmeup.newInstance().saveToInfisical(nested, connection)
    } catch {
        throw new Error("Could not save Infisical secrets")
    }
}

const bootstrapKeys = new Set(["PLS_INFISICAL_CLIENT_ID", "PLS_INFISICAL_CLIENT_SECRET", "PLS_INFISICAL_PROJECT_ID", "PLS_INFISICAL_ENVIRONMENT", "PLS_INFISICAL_SECRET_PATH", "PLS_INFISICAL_SITE_URL"])

export async function preloadInfisicalSecrets(env: Env = process.env) {
    const connection = infisicalConnection(env)
    if (!connection) return
    const fallback: Env = Object.create(null)
    for (const [name, value] of Object.entries(await readInfisicalSecrets(connection))) {
        if (bootstrapKeys.has(name)) continue
        fallback[name] = env[name]
        env[name] = value
    }
    delete env.PLS_INFISICAL_CLIENT_SECRET
    if (env === process.env) state[preloadStateKey] = {connection, fallback}
}
