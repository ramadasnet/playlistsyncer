// Report health only when the jobs server can reach its required database.
import {defineEventHandler, setResponseStatus} from "h3"
import {assertDatabaseReachable, getDatabase} from "../../utils/database"
import logger from "../../utils/logger"

// Ping MongoDB and report whether this jobs process can reach it.
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
