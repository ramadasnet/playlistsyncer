// Parse environment flags shared by server configuration and the public UI.

// Convert common truthy/falsey environment strings into a boolean.
export function parseBooleanEnvFlag(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
        return value
    }
    if (value === "" || value === undefined || value === null) {
        return false
    }
    const normalized = String(value).trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(normalized)) {
        return true
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
        return false
    }
    return undefined
}

// Resolve SAFE_MODE for the public runtime configuration.
export function resolvePublicSafeMode(environment: Record<string, string | undefined>, baked = false): boolean {
    const parsed = parseBooleanEnvFlag(environment.SAFE_MODE)
    return parsed ?? baked
}

// Treat public runtime values as enabled only for explicit true flags.
export function isPublicSafeMode(value: unknown): boolean {
    return parseBooleanEnvFlag(value) === true
}
