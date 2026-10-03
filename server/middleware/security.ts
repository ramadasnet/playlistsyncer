// Add browser security headers, a strict CSP, and reject cross-site state mutations.
import {randomBytes} from "node:crypto"
import type {H3Event} from "h3"
import {getServerConfig} from "../utils/config"

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])
const externalRoutes = ["/api/webhooks/"]
const csrfCookie = "ps_csrf"
const csrfHeader = "x-csrf-token"

// Strict default CSP; inline styles and scripts stay allowed because Nuxt ships them during hydration.
export function contentSecurityPolicy(): string {
    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https://fonts.gstatic.com",
        process.env.NODE_ENV === "production" ? "connect-src 'self'" : "connect-src 'self' ws:",
        // The support page embeds the Chatbase assistant in an iframe, which falls back to default-src without this allowlist.
        "frame-src 'self' https://www.chatbase.co",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join("; ")
}

// Issue the double-submit CSRF cookie the first time the browser loads the app.
function issueCsrfCookie(event: H3Event) {
    if (!getCookie(event, csrfCookie)) {
        setCookie(event, csrfCookie, randomBytes(32).toString("base64url"), {
            httpOnly: false,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/"
        })
    }
}

// Protect browser-originated mutations while allowing signed external callbacks.
export default defineEventHandler((event) => {
    setResponseHeaders(event, {
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": contentSecurityPolicy()
    })
    const path = getRequestURL(event).pathname
    if (!mutationMethods.has(event.method) || externalRoutes.some((prefix) => path.startsWith(prefix))) {
        issueCsrfCookie(event)
        return
    }
    const fetchSite = getHeader(event, "sec-fetch-site")
    const origin = getHeader(event, "origin")
    if (fetchSite === "cross-site" || (origin && origin !== new URL(getServerConfig().appUrl).origin)) {
        throw createError({statusCode: 403, statusMessage: "Cross-site mutation rejected"})
    }
    // Double-submit validation pairs the cookie issued on page loads with a request header.
    const cookieToken = getCookie(event, csrfCookie)
    const headerToken = getHeader(event, csrfHeader)
    if (!cookieToken || headerToken !== cookieToken) {
        throw createError({statusCode: 403, statusMessage: "Missing or invalid CSRF token"})
    }
})
