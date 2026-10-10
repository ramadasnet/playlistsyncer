// Send due weekly synchronization summaries from a scheduler request.
import {defineEventHandler} from "h3"
import {collections} from "../../data/collections"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {sendMail} from "../../domain/mail/send"
import {createWeeklySummaryStore, sendDueWeeklySyncSummaries} from "../../domain/mail/weekly-sync-summary"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"

// Resolve entitlement and mail dependencies for the summary worker.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    const db = await collections()
    const result = await sendDueWeeklySyncSummaries({
        store: createWeeklySummaryStore(db),
        resolveTier: (user) => resolveEntitlement(user).tier,
        send: sendMail,
        appUrl: getServerConfig().appUrl
    })
    const log = result.failed ? logger.warn : logger.info
    log("Jobs.weeklySyncSummary", `Processed ${result.processed}`, `Sent ${result.sent}`, `Skipped ${result.skipped}`, `Failed ${result.failed}`)
    return result
})
