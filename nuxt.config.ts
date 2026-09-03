// https://nuxt.com/docs/api/configuration/nuxt-config
const appUrl = process.env.APP_URL || process.env.NUXT_PUBLIC_SITE_URL || "http://localhost:3007"
const appHost = new URL(appUrl).hostname

export default defineNuxtConfig({
    compatibilityDate: "2025-07-15",
    css: ["~/assets/css/main.css"],
    devtools: {enabled: true},
    modules: ["@pinia/nuxt"],
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
        preset: "bun"
    },
    runtimeConfig: {
        public: {
            appName: process.env.NUXT_PUBLIC_APP_NAME || "PlaylistSyncer",
            proPrice: process.env.NUXT_PUBLIC_PRO_PRICE || "Configured at checkout",
            supportEmail: process.env.NUXT_PUBLIC_SUPPORT_EMAIL || "info@playlistsyncer.com",
            siteUrl: appUrl
        }
    },
    typescript: {
        strict: true,
        typeCheck: true
    }
})
