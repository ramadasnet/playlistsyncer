// Add browser security headers and reject cross-site state mutations.
import {getServerConfig} from "../utils/config"

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])
const externalRoutes = ["/api/jobs/", "/api/webhooks/"]

// Protect browser-originated mutations while allowing signed external callbacks.
export default defineEventHandler((event) => {
    setResponseHeaders(event, {
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
    })
    const path = getRequestURL(event).pathname
    if (!mutationMethods.has(event.method) || externalRoutes.some((prefix) => path.startsWith(prefix))) {
        return
    }
    const fetchSite = getHeader(event, "sec-fetch-site")
    const origin = getHeader(event, "origin")
    if (fetchSite === "cross-site" || (origin && origin !== new URL(getServerConfig().appUrl).origin)) {
        throw createError({statusCode: 403, statusMessage: "Cross-site mutation rejected"})
    }
})
