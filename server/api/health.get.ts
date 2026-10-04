// Report health only when the web server can reach its required database.
import {assertDatabaseReachable, getDatabase} from "../utils/database"
import logger from "../utils/logger"

export default defineEventHandler(async (event) => {
    try {
        const database = await getDatabase()
        await assertDatabaseReachable(database)
        return {status: "ok", timestamp: new Date().toISOString()}
    } catch (error) {
        logger.error("Health.check", error, "MongoDB is unavailable")
        setResponseStatus(event, 503)
        return {status: "unhealthy", timestamp: new Date().toISOString()}
    }
})
