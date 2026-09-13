// Manage the shared MongoDB client and application database handle.
import {MongoClient, type Db} from "mongodb"
import {getServerConfig, requireConfig} from "./config"
import logger from "./logger"

let client: MongoClient | undefined
let database: Db | undefined

// Connect lazily and reuse the database handle for all requests.
export async function getDatabase(): Promise<Db> {
    if (database) {
        return database
    }

    const config = getServerConfig()
    logger.info("Database.connect", `Database ${config.mongodbDatabase}`)
    client = new MongoClient(requireConfig("mongodbUri"), {
        appName: "playlistsync",
        maxPoolSize: 20,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5000
    })
    try {
        await client.connect()
        database = client.db(config.mongodbDatabase)
        logger.info("Database.connect", `Connected to database ${config.mongodbDatabase}`)
        return database
    } catch (error) {
        logger.error("Database.connect", error, `Failed to connect to database ${config.mongodbDatabase}`)
        await client.close().catch(() => undefined)
        client = undefined
        throw error
    }
}

// Close the MongoDB client and clear cached connection state.
export async function closeDatabase(): Promise<void> {
    if (client) {
        logger.info("Database.close", "Closing MongoDB connection")
    }
    await client?.close()
    client = undefined
    database = undefined
}
