// Verify and process Creem billing webhook events.
import {constructWebhookEventEntity} from "creem/webhooks"
import {processCreemEvent} from "../../domain/billing/creem"
import {requireConfig} from "../../utils/config"
import logger from "../../utils/logger"

// Reject unsigned payloads before handing events to billing logic.
export default defineEventHandler(async (event) => {
    const signature = getHeader(event, "creem-signature")
    const body = await readRawBody(event)
    if (!signature || !body) {
        logger.warn("Creem.webhook", "Missing signature or payload")
        throw createError({statusCode: 400, statusMessage: "Missing Creem signature or payload"})
    }
    let creemEvent
    try {
        creemEvent = await constructWebhookEventEntity(body, {"creem-signature": signature}, {secret: requireConfig("creemWebhookSecret")})
    } catch (error) {
        logger.warn("Creem.webhook", "Signature verification failed", error)
        throw createError({statusCode: 400, statusMessage: "Invalid Creem webhook"})
    }
    await processCreemEvent(creemEvent)
    return {received: true}
})
