// Install h3's error helper before the jobs modules load. Nitro provides it for the website only.
// PM2 loads this file with require(), which rejects a top-level await while startup is still pending.
import {createError} from "h3"
import logger from "../utils/logger"

const globals = globalThis as typeof globalThis & {createError: typeof createError}
globals.createError = createError

void import("./start")
    .then(({startJobsServer}) => startJobsServer())
    .catch((error: unknown) => {
        logger.error("Jobs.startup", error)
        process.exit(1)
    })
