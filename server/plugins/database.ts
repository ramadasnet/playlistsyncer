// Initialize MongoDB indexes at startup and close the client on shutdown.
import {ensureIndexes} from "../data/collections"
import {getServerConfig} from "../utils/config"
import {closeDatabase} from "../utils/database"
import logger from "../utils/logger"

// Skip database initialization when the deployment intentionally has no URI.
export default defineNitroPlugin(async (nitroApp) => {
    if (getServerConfig().mongodbUri) {
        logger.info("Database.init", "Ensuring MongoDB indexes")
        try {
            await ensureIndexes()
            logger.info("Database.init", "MongoDB indexes ready")
        } catch (error) {
            logger.error("Database.init", error, "Failed to initialize MongoDB")
            throw error
        }
    } else {
        logger.warn("Database.init", "MONGODB_URI is not configured, database-backed routes are unavailable")
    }
    nitroApp.hooks.hook("close", closeDatabase)
})
