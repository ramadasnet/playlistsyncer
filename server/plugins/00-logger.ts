// Register startup, request-error, and shutdown logging hooks, and refuse to start with invalid production configuration.
import {assertStartupConfig, getServerConfig} from "../utils/config"
import {infisicalLoadedKeysEnv} from "../utils/infisical"
import logger from "../utils/logger"

// Attach lifecycle logging to the Nitro application.
export default defineNitroPlugin((nitroApp) => {
    logger.info("PlaylistSync.startup", `PID ${process.pid}`, `Environment ${process.env.NODE_ENV || "development"}`)
    const loadedKeysJson = process.env[infisicalLoadedKeysEnv]
    delete process.env[infisicalLoadedKeysEnv]
    if (loadedKeysJson) {
        try {
            const loadedKeys: unknown = JSON.parse(loadedKeysJson)
            if (Array.isArray(loadedKeys) && loadedKeys.every((key) => typeof key === "string")) {
                logger.info("Infisical", `Loaded keys: ${loadedKeys.join(", ") || "(none)"}`)
            } else {
                logger.warn("Infisical", "Invalid loaded-key startup metadata")
            }
        } catch {
            logger.warn("Infisical", "Invalid loaded-key startup metadata")
        }
    }
    try {
        assertStartupConfig("website")
    } catch (error) {
        // Exit before Bun starts listening, so the health check never reports a misconfigured process as healthy.
        logger.error("PlaylistSync.startup", error)
        process.exit(1)
    }
    if (getServerConfig().safeMode) {
        logger.warn("PlaylistSync.startup", "PLS_SAFE_MODE is enabled; music providers will not be written")
    }
    logger.info("PlaylistSync.startup", `URL: ${getServerConfig().appUrl}`)

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
