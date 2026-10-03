// Install h3's error helper before the jobs modules load. Nitro provides it for the website only.
import {createError} from "h3"
import logger from "../utils/logger"

const globals = globalThis as typeof globalThis & {createError: typeof createError}
globals.createError = createError

try {
    const {startJobsServer} = await import("./start")
    await startJobsServer()
} catch (error) {
    logger.error("Jobs.startup", error)
    process.exit(1)
}
