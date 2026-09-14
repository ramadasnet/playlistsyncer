// Register startup, request-error, and shutdown logging hooks.
import {getServerConfig} from "../utils/config"
import logger from "../utils/logger"

// Attach lifecycle logging to the Nitro application.
export default defineNitroPlugin((nitroApp) => {
    logger.info("PlaylistSync.startup", `PID ${process.pid}`, `Environment ${process.env.NODE_ENV || "development"}`)
    if (getServerConfig().safeMode) {
        logger.warn("PlaylistSync.startup", "SAFE_MODE is enabled; music providers will not be written")
    }

    nitroApp.hooks.hook("error", (error, context) => {
        const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500
        const request = context.event ? `${context.event.method} ${getRequestURL(context.event).pathname}` : "Non-request error"
        if (statusCode >= 500) {
            logger.error("PlaylistSync.request", request, `Status ${statusCode}`, error)
        } else {
            logger.warn("PlaylistSync.request", request, `Status ${statusCode}`, error.message)
        }
    })

    nitroApp.hooks.hook("close", () => logger.info("PlaylistSync.shutdown", `PID ${process.pid}`))
})
