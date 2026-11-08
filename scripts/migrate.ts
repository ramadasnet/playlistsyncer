// Run maintenance explicitly against the configured database, never during app startup.
import {runMigrations} from "../server/data/migrations"
import {closeDatabase, getDatabase} from "../server/utils/database"
import logger from "../server/utils/logger"

try {
    await runMigrations(await getDatabase())
} catch (error) {
    logger.error("Database.migrate", error)
    process.exitCode = 1
} finally {
    await closeDatabase()
}
