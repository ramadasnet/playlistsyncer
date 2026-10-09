// HTTP application for scheduled jobs, separate from the website process.
import {createApp, createError, createRouter, type App} from "h3"
import logger from "../utils/logger"
import {isShuttingDown} from "../utils/shutdown"
import health from "./routes/health"
import syncDue from "./routes/sync-due"
import syncTask from "./routes/sync-task"
import weeklySyncSummary from "./routes/weekly-sync-summary"

// Mount the same job paths the scheduler already calls, and log failed requests like the website does.
export function createJobsApp(): App {
    const app = createApp({
        onRequest() {
            if (isShuttingDown()) {
                throw createError({statusCode: 503, statusMessage: "Jobs server is shutting down"})
            }
        },
        onError(error, event) {
            const request = `${event.method} ${event.path}`
            if (error.statusCode >= 500) {
                logger.error("Jobs.request", request, `Status ${error.statusCode}`, error)
            } else {
                logger.warn("Jobs.request", request, `Status ${error.statusCode}`, error.message)
            }
        }
    })
    const router = createRouter()
    router.get("/api/health", health)
    router.post("/api/jobs/sync-due", syncDue)
    router.post("/api/jobs/sync-task/:id", syncTask)
    router.post("/api/jobs/weekly-sync-summary", weeklySyncSummary)
    app.use(router.handler)
    return app
}
