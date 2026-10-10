// Resolve post-login redirects against a placeholder origin, so only same-origin paths survive.
const placeholderOrigin = "https://playlistsyncer.invalid"

// Accept only local paths. Browsers treat "\" like "/" and drop tabs and newlines, so "/\evil.example" is another origin.
export function normalizeRedirect(value: unknown, fallback = "/sync"): string {
    if (typeof value !== "string" || !value.startsWith("/")) {
        return fallback
    }
    try {
        const url = new URL(value, placeholderOrigin)
        // A path such as "/.//evil.example" normalizes to "//evil.example", which is protocol-relative once sent alone.
        if (url.origin !== placeholderOrigin || url.pathname.startsWith("//")) {
            return fallback
        }
        return `${url.pathname}${url.search}${url.hash}`
    } catch {
        return fallback
    }
}
