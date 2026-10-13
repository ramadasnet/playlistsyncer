// Delete old sync runs and inactive users from a scheduler request.
import {defineEventHandler} from "h3"
import {sendMail} from "../../domain/mail/send"
import {runSyncCleanup as cleanup, type SyncCleanupOptions} from "../../domain/sync-cleanup"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"

/**
 * Runs the sync cleanup and logs its counts.
 * @param options Overrides for the default retention periods and batch size.
 */
export async function runSyncCleanup(options: Partial<SyncCleanupOptions> = {}) {
    const result = await cleanup({options, send: sendMail, appUrl: getServerConfig().appUrl})
    const log = result.failed ? logger.warn : logger.info
    log("Jobs.syncCleanup", `Runs deleted ${result.runsDeleted}`, `Users deleted ${result.usersDeleted}`, `Users warned ${result.usersWarned}`, `Failed ${result.failed}`)
    return result
}

// Require scheduler authentication, then clean up with the defaults.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    return runSyncCleanup()
})
