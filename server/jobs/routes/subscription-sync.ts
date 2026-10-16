// Reconcile stored Creem subscriptions from a scheduler request.
import {defineEventHandler} from "h3"
import {getCreem} from "../../domain/billing/creem"
import {syncCreemSubscriptions} from "../../domain/billing/subscription-sync"
import {revertExpiredPromotionalAccess} from "../../domain/billing/task-entitlement"
import {requireConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {requireScheduler} from "../../utils/scheduler-auth"

/**
 * Reads subscriptions from Creem and updates local status and payment dates.
 * The promotional revert runs first so an unreachable Creem cannot skip it, and a paid subscription
 * the same Creem read finds resumes the tasks it paused.
 */
export async function runSubscriptionSync() {
    const reverted = await revertExpiredPromotionalAccess()
    const creem = getCreem()
    const result = await syncCreemSubscriptions({
        productId: requireConfig("creemProProductId"),
        source: {
            async search(pageNumber, pageSize) {
                const page = await creem.subscriptions.search(pageNumber, pageSize)
                return page.result
            },
            get: (subscriptionId) => creem.subscriptions.get(subscriptionId)
        }
    })
    const log = result.failed || reverted.stopped ? logger.warn : logger.info
    log(
        "Jobs.subscriptionSync",
        `Checked ${result.checked}`,
        `Updated ${result.updated}`,
        `Unchanged ${result.unchanged}`,
        `Unmatched ${result.unmatched}`,
        `Missing ${result.missing}`,
        `Failed ${result.failed}`,
        `Reverted ${reverted.users}`,
        result.stopped || reverted.stopped ? "Stopped early" : "Finished"
    )
    return result
}

// Require scheduler authentication, then reconcile every configured PRO subscription.
export default defineEventHandler(async (event) => {
    requireScheduler(event)
    return runSubscriptionSync()
})
