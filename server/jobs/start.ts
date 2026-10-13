// Boot the scheduled-jobs HTTP server, its cron schedule, and its MongoDB connection.
import {createServer, type Server} from "node:http"
import {toNodeListener} from "h3"
import {ensureIndexes} from "../data/collections"
import {assertStartupConfig, getServerConfig} from "../utils/config"
import {closeDatabase} from "../utils/database"
import logger from "../utils/logger"
import {drainSyncRuns} from "../utils/shutdown"
import {createJobsApp} from "./app"
import {drainNonSyncRequests} from "./requests"
import {createJobScheduler, loadJobSchedule} from "./schedule"

const scheduler = createJobScheduler()

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
    assertStartupConfig("jobs")
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
    const scheduledJobs = loadJobSchedule()

    const port = resolveJobsPort()
    const host = process.env.HOST || "0.0.0.0"
    const server = createServer(toNodeListener(createJobsApp()))
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
    })
    logger.info("Jobs.startup", `Listening on ${host}:${port}`)
    scheduler.start(scheduledJobs)

    const shutdown = async (signal: string) => {
        logger.info("Jobs.shutdown", signal)
        await shutdownJobsServer(server, config.shutdownTimeoutSeconds * 1000)
        process.exit(0)
    }
    process.once("SIGINT", () => void shutdown("SIGINT"))
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
    return server
}

/**
 * Stops new connections and new scheduled ticks, finishes accepted requests, scheduled jobs, and tracked sync runs, then closes MongoDB.
 * server.close() would wait without a deadline for a long sync-due request, so the drains share the shutdown budget.
 * @param server Jobs HTTP server.
 * @param timeoutMs Total budget before MongoDB is closed.
 * @param closeDb Closes the database after the drains return.
 */
export async function shutdownJobsServer(server: Server, timeoutMs: number, closeDb: () => Promise<void> = closeDatabase): Promise<void> {
    server.close()
    await Promise.all([drainSyncRuns(timeoutMs), drainNonSyncRequests(timeoutMs), scheduler.drain(timeoutMs)])
    await closeDb()
}
