import {z} from "zod"

/** Validate the independent admin application's environment settings. */
export function parseAdminConfig(env: Record<string, string | undefined>) {
    const production = env.NODE_ENV === "production"
    return z
        .object({
            url: z
                .url()
                .refine((value) => {
                    const url = new URL(value)
                    return url.pathname === "/" && !url.search && !url.hash && (production ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol))
                }, "Admin URL must be an origin, using HTTPS in production")
                .transform((value) => new URL(value).origin),
            googleClientId: z.string().default(""),
            googleClientSecret: z.string().default(""),
            allowedEmails: z.array(z.email().transform((value) => value.toLowerCase())),
            sessionHours: z.coerce.number().int().min(1).max(24).default(8)
        })
        .parse({
            url: env.PLS_ADMIN_URL || (production ? "https://admin.playlistsyncer.com" : "http://localhost:3009"),
            googleClientId: env.PLS_ADMIN_GOOGLE_CLIENT_ID,
            googleClientSecret: env.PLS_ADMIN_GOOGLE_CLIENT_SECRET,
            allowedEmails: (env.PLS_ADMIN_ALLOWED_EMAILS || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            sessionHours: env.PLS_ADMIN_SESSION_HOURS || undefined
        })
}

/** Resolve settings on the server only; no credentials enter runtimeConfig.public. */
export function adminConfig() {
    return parseAdminConfig(process.env)
}

/** Deny access by default and compare normalized, verified Google email addresses. */
export function isAllowedAdmin(email: string, verified: boolean, config = adminConfig()): boolean {
    return verified && config.allowedEmails.includes(email.trim().toLowerCase())
}
