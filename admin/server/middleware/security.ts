import {defineEventHandler, getRequestURL, setResponseHeaders} from "h3"
import {assertAdminOrigin, requireAdmin} from "../utils/auth"

export default defineEventHandler(async (event) => {
    setResponseHeaders(event, {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    })
    const path = getRequestURL(event).pathname
    if (!path.startsWith("/api/")) return
    if (!["GET", "HEAD"].includes(event.method)) assertAdminOrigin(event)
    if (path === "/api/auth/google" || path === "/api/auth/callback" || path === "/api/session" || path === "/api/logout") return
    event.context.admin = await requireAdmin(event)
})
