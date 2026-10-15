// Resolve the configured application URL or the environment-specific default.
export function resolveAppUrl(environment: Record<string, string | undefined>): string {
    return environment.PLS_APP_URL || (environment.NODE_ENV === "production" ? "https://playlistsyncer.com/" : "http://localhost:3007/")
}
