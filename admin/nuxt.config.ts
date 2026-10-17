import {fileURLToPath} from "node:url"

const shared = fileURLToPath(new URL("../shared", import.meta.url))

export default defineNuxtConfig({
    compatibilityDate: "2025-07-15",
    devtools: {enabled: false},
    vite: {server: {allowedHosts: [new URL(process.env.PLS_ADMIN_URL || "http://localhost:3009").hostname]}},
    alias: {"~~/shared": shared},
    css: ["~/assets/admin.css"],
    nitro: {preset: "bun", alias: {"~~/shared": shared}},
    app: {head: {title: "PlaylistSyncer Admin", meta: [{name: "robots", content: "noindex, nofollow"}]}},
    typescript: {strict: true, typeCheck: false}
})
