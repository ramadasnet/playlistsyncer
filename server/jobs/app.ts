// HTTP application for scheduled jobs, separate from the website process.
import {createApp, createRouter, type App} from "h3"
import health from "./routes/health"
import syncDue from "./routes/sync-due"
import syncTask from "./routes/sync-task"
import weeklySyncSummary from "./routes/weekly-sync-summary"

// Mount the same job paths the scheduler already calls.
export function createJobsApp(): App {
    const app = createApp()
    const router = createRouter()
    router.get("/api/health", health)
    router.post("/api/jobs/sync-due", syncDue)
    router.post("/api/jobs/sync-task/:id", syncTask)
    router.post("/api/jobs/weekly-sync-summary", weeklySyncSummary)
    app.use(router.handler)
    return app
}
