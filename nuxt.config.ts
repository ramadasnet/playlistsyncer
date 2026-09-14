// https://nuxt.com/docs/api/configuration/nuxt-config
import {resolvePublicSafeMode} from "./shared/env-flag"
import {defaultProSyncIntervalHours} from "./shared/sync-cadence"

const appUrl = process.env.APP_URL || process.env.NUXT_PUBLIC_SITE_URL || "http://localhost:3007"
const appHost = new URL(appUrl).hostname
const proSyncIntervalHours = Number(process.env.PRO_SYNC_INTERVAL_HOURS || process.env.NUXT_PUBLIC_PRO_SYNC_INTERVAL_HOURS || defaultProSyncIntervalHours)

export default defineNuxtConfig({
    compatibilityDate: "2025-07-15",
    css: ["~/assets/css/main.css"],
    // DevTools instruments the whole app; keep it opt-in so idle `nuxt dev` stays lean.
    devtools: {enabled: process.env.NUXT_DEVTOOLS === "true"},
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
            appName: process.env.NUXT_PUBLIC_APP_NAME || "PlaylistSyncer",
            proPrice: process.env.NUXT_PUBLIC_PRO_PRICE || "9.99",
            supportEmail: process.env.NUXT_PUBLIC_SUPPORT_EMAIL || "info@playlistsyncer.com",
            chatbaseHelpUrl: process.env.NUXT_PUBLIC_CHATBASE_HELP_URL || "https://www.chatbase.co/taNwdeaQwZIYPfxthXqRu/help",
            siteUrl: appUrl,
            proSubscriptionRequiredAt: process.env.NUXT_PUBLIC_PRO_SUBSCRIPTION_REQUIRED_AT || process.env.PRO_SUBSCRIPTION_REQUIRED_AT || "",
            proSyncIntervalHours: Number.isFinite(proSyncIntervalHours) && proSyncIntervalHours > 0 ? proSyncIntervalHours : defaultProSyncIntervalHours,
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
