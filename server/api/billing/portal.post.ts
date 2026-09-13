// Create a hosted billing-portal link for an existing customer.
import {requireUser} from "../../domain/auth/session"
import {getCreem} from "../../domain/billing/creem"
import logger from "../../utils/logger"

// Require a billing customer before delegating to Creem.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    if (!user.creemCustomerId) {
        throw createError({statusCode: 409, statusMessage: "No billing account exists yet"})
    }
    const portal = await getCreem().customers.generateBillingLinks({
        customerId: user.creemCustomerId
    })
    logger.info("Billing.portal", `User ${user._id!.toHexString()}`, "Portal link created")
    return {url: portal.customerPortalLink}
})
