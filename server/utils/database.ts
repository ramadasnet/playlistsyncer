// Manage the shared MongoDB client and application database handle.
import {MongoClient, type Db} from "mongodb"
import {getServerConfig, requireConfig} from "./config"
import logger from "./logger"
import {firestoreMongoOptions, firestoreUriDatabase} from "./mongodb"

let client: MongoClient | undefined
let database: Db | undefined

// Connect lazily and reuse the database handle for all requests.
export async function getDatabase(): Promise<Db> {
    if (database) {
        return database
    }

    const config = getServerConfig()
    const uri = requireConfig("mongodbUri")
    const uriDatabase = firestoreUriDatabase(uri)
    if (uriDatabase && uriDatabase !== config.mongodbDatabase) {
        logger.warn("Database.connect", `PLS_MONGODB_DATABASE is ${config.mongodbDatabase}`, `Firestore URI database is ${uriDatabase}`)
    }
    logger.info("Database.connect", `Database ${config.mongodbDatabase}`)
    client = new MongoClient(uri, {
        appName: "playlistsync",
        maxPoolSize: 20,
        minPoolSize: 1,
        // Close connections opened by request bursts so idle processes return to one socket (and one Oracle/ORDS session).
        maxIdleTimeMS: 60_000,
        serverSelectionTimeoutMS: 5000,
        ...firestoreMongoOptions(uri)
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

// Confirm the database accepts a command. Firestore does not implement ping; connectionStatus is supported by both servers.
export async function assertDatabaseReachable(database: Db): Promise<void> {
    await database.command({connectionStatus: 1}, {timeoutMS: 3000})
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
