// Boot the scheduled-jobs HTTP server and connect it to MongoDB.
import {createServer, type Server} from "node:http"
import {toNodeListener} from "h3"
import {ensureIndexes} from "../data/collections"
import {getServerConfig} from "../utils/config"
import {closeDatabase} from "../utils/database"
import logger from "../utils/logger"
import {createJobsApp} from "./app"

// Read the jobs listener port without using the website PORT.
export function resolveJobsPort(raw = process.env.PLS_JOBS_PORT): number {
    if (raw === undefined || raw === "") return 3008
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PLS_JOBS_PORT must be an integer from 1 to 65535")
    }
    return port
}

// Listen until the process is asked to stop, then close the database.
export async function startJobsServer(): Promise<Server> {
    const config = getServerConfig()
    logger.info("Jobs.startup", `PID ${process.pid}`, `Environment ${process.env.NODE_ENV || "development"}`)
    if (config.safeMode) {
        logger.warn("Jobs.startup", "PLS_SAFE_MODE is enabled; music providers will not be written")
    }
    if (!config.mongodbUri) {
        throw new Error("PLS_MONGODB_URI is not configured")
    }
    // Only this process creates indexes, so the website does not race the same startup.
    logger.info("Jobs.startup", "Ensuring MongoDB indexes")
    await ensureIndexes()
    logger.info("Jobs.startup", "MongoDB indexes ready")

    const port = resolveJobsPort()
    const host = process.env.HOST || "0.0.0.0"
    const server = createServer(toNodeListener(createJobsApp()))
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
    })
    logger.info("Jobs.startup", `Listening on ${host}:${port}`)

    const shutdown = async (signal: string) => {
        logger.info("Jobs.shutdown", signal)
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await closeDatabase()
        process.exit(0)
    }
    process.once("SIGINT", () => void shutdown("SIGINT"))
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
    return server
}
