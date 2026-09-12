import {requireUser} from "../../domain/auth/session"
import {getCreem} from "../../domain/billing/creem"
import {canStartCheckout, resolveEntitlement} from "../../domain/billing/entitlement"
import {getServerConfig, requireConfig} from "../../utils/config"
import logger from "../../utils/logger"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    if (!canStartCheckout(resolveEntitlement(user))) {
        throw createError({statusCode: 409, statusMessage: "The account already has PRO access"})
    }
    if (!user.email) {
        throw createError({statusCode: 400, statusMessage: "Confirm an email address before upgrading"})
    }
    const checkout = await getCreem().checkouts.create({
        productId: requireConfig("creemProProductId"),
        customer: user.creemCustomerId ? {id: user.creemCustomerId} : {email: user.email, name: user.displayName},
        successUrl: `${getServerConfig().appUrl}/account?checkout=success`,
        metadata: {userId: user._id!.toHexString()}
    })
    logger.info("Billing.checkout", `User ${user._id!.toHexString()}`, "Checkout created")
    return {url: checkout.checkoutUrl}
})
