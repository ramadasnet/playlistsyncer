import {spawn} from "node:child_process"
import {existsSync} from "node:fs"
import {resolve} from "node:path"
import logger from "../utils/logger"

export default defineNitroPlugin((nitroApp) => {
    const cloudflaredDirectory = resolve(process.cwd(), ".cloudflared")
    if (!existsSync(cloudflaredDirectory)) {
        return
    }

    if (import.meta.dev) {
        nitroApp.hooks.hook("render:html", (htmlContext) => {
            htmlContext.head = htmlContext.head.map((entry) =>
                entry.replace(
                    /href="(\/_nuxt\/[^"?]+\.css)(\?[^"#]*)?"/g,
                    (_match, path: string, query: string | undefined) =>
                        `href="${path}${query ? `${query}&` : "?"}direct&dev-no-store"`
                )
            )
        })
    }

    const configPath = resolve(cloudflaredDirectory, "config.yml")
    logger.info("Cloudflared.startup", `Config ${configPath}`)

    const tunnel = spawn("cloudflared", ["tunnel", "--config", configPath, "run"], {
        cwd: process.cwd(),
        stdio: "ignore"
    })

    tunnel.on("error", (error) => logger.error("Cloudflared.process", error, "Failed to start tunnel"))
    tunnel.on("exit", (code, signal) =>
        logger.info("Cloudflared.shutdown", signal ? `Signal ${signal}` : `Exit code ${code}`)
    )

    nitroApp.hooks.hook("close", () => {
        if (tunnel.exitCode === null && tunnel.signalCode === null) {
            tunnel.kill()
        }
    })
})
