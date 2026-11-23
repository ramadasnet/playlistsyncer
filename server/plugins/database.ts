// Close the MongoDB client on shutdown. Index creation runs only in the jobs process.
import {getServerConfig} from "../utils/config"
import {closeDatabase} from "../utils/database"
import logger from "../utils/logger"
import {watchRuntimeSettings} from "../utils/runtime-settings"

// Warn when the website has no database, and close the client when Nitro stops.
export default defineNitroPlugin((nitroApp) => {
    if (!getServerConfig().mongodbUri) {
        logger.warn("Database.init", "PLS_MONGODB_URI is not configured, database-backed routes are unavailable")
    }
    const settings = watchRuntimeSettings()
    void settings.ready.catch(() => logger.error("Settings.init", "Could not load application settings"))
    nitroApp.hooks.hook("close", async () => {
        settings.stop()
        await closeDatabase()
    })
})
