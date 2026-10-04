// Close the MongoDB client on shutdown. Index creation runs only in the jobs process.
import {getServerConfig} from "../utils/config"
import {closeDatabase} from "../utils/database"
import logger from "../utils/logger"

// Warn when the website has no database, and close the client when Nitro stops.
export default defineNitroPlugin(async (nitroApp) => {
    if (!getServerConfig().mongodbUri) {
        logger.warn("Database.init", "PLS_MONGODB_URI is not configured, database-backed routes are unavailable")
    }
    nitroApp.hooks.hook("close", closeDatabase)
})
