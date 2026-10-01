// https://nuxt.com/docs/api/configuration/nuxt-config
import {resolvePublicSafeMode} from "./shared/env-flag"
import {defaultProSyncIntervalMinutes} from "./shared/sync-cadence"

const appUrl = process.env.PLS_APP_URL || "http://localhost:3007"
const appHost = new URL(appUrl).hostname
const proSyncIntervalMinutes = Number(process.env.PLS_TASKSYNC_INTERVAL || defaultProSyncIntervalMinutes)

export default defineNuxtConfig({
    compatibilityDate: "2025-07-15",
    app: {
        head: {
            link: [{rel: "icon", type: "image/svg+xml", href: "/logo-mark.svg"}]
        }
    },
    css: ["~/assets/css/main.css"],
    // DevTools instruments the whole app; keep it opt-in so idle `nuxt dev` stays lean.
    devtools: {enabled: process.env.PLS_DEVTOOLS === "true"},
    modules: ["@pinia/nuxt"],
    sourcemap: {
        server: false
    },
    vite: {
        server: {
            allowedHosts: [appHost],
            headers: {
                "Cache-Control": "no-store, max-age=0",
                "CDN-Cache-Control": "no-store",
                "Cloudflare-CDN-Cache-Control": "no-store"
            }
        }
    },
    nitro: {
        preset: "bun",
        sourceMap: false
    },
    runtimeConfig: {
        public: {
            appName: process.env.PLS_APP_NAME || "PlaylistSyncer",
            // Fallback display price. Startup replaces this with the configured Creem PRO product price when billing is configured.
            proPrice: "9.99 EUR",
            supportEmail: process.env.PLS_SUPPORT_EMAIL,
            chatbaseHelpUrl: process.env.PLS_CHATBASE_HELP_URL,
            siteUrl: appUrl,
            proSubscriptionRequiredAt: process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT || "",
            proSyncIntervalMinutes: Number.isInteger(proSyncIntervalMinutes) && proSyncIntervalMinutes > 0 ? proSyncIntervalMinutes : defaultProSyncIntervalMinutes,
            safeMode: resolvePublicSafeMode(process.env)
        }
    },
    typescript: {
        strict: true,
        // Skip the persistent vue-tsc watcher during `nuxt dev` / `nuxt build`.
        // Typecheck with `bun run typecheck` or `bun run check` instead.
        typeCheck: false
    }
})
