import {existsSync} from "node:fs"
import {resolve} from "node:path"

export default defineNitroPlugin((nitroApp) => {
    const cloudflaredDirectory = resolve(process.cwd(), ".cloudflared")
    if (!existsSync(cloudflaredDirectory)) {
        return
    }

    if (import.meta.dev) {
        nitroApp.hooks.hook("render:html", (htmlContext) => {
            htmlContext.head = htmlContext.head.map((entry) => entry.replace(/href="(\/_nuxt\/[^"?]+\.css)(\?[^"#]*)?"/g, (_match, path: string, query: string | undefined) => `href="${path}${query ? `${query}&` : "?"}direct&dev-no-store"`))
        })
    }
})
