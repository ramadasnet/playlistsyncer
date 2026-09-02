import {Creem} from "creem"
import type {SubscriptionEntity, WebhookEventEntity} from "creem/models/components"
import {ObjectId} from "mongodb"
import {collections} from "../../data/collections"
import {getServerConfig, requireConfig} from "../../utils/config"
import logger from "../../utils/logger"

let creemClient: Creem | undefined

export function getCreem(): Creem {
    if (!creemClient) {
        const server = getServerConfig().creemServer
        creemClient = new Creem({apiKey: requireConfig("creemApiKey"), server})
        logger.info("Creem.init", `Server ${server}`)
    }
    return creemClient
}

type CreemSubscription = Pick<SubscriptionEntity, "id" | "customer" | "status">
const paidStatuses = new Set(["active", "trialing", "scheduled_cancel"])

export function hasPaidEntitlement(status: string): boolean {
    return paidStatuses.has(status)
}

function customerId(customer: CreemSubscription["customer"]): string {
    return typeof customer === "string" ? customer : customer.id
}

export async function applySubscription(
    subscription: CreemSubscription,
    status: string = subscription.status
): Promise<void> {
    const isPaid = hasPaidEntitlement(status)
    const db = await collections()
    const user = await db.users.findOneAndUpdate(
        {creemCustomerId: customerId(subscription.customer)},
        {
            $set: {
                creemSubscriptionId: subscription.id,
                creemSubscriptionStatus: status,
                tier: isPaid ? "pro" : "free",
                updatedAt: new Date()
            }
        },
        {returnDocument: "after"}
    )
    if (!user) {
        logger.warn("Creem.applySubscription", `Customer ${customerId(subscription.customer)}`, "User not found")
        return
    }
    logger.info(
        "Creem.applySubscription",
        `User ${user._id!.toHexString()}`,
        `Subscription ${subscription.id}`,
        `Status ${status}`,
        `Tier ${isPaid ? "pro" : "free"}`
    )
    if (isPaid) {
        const resumed = await db.syncTasks.updateMany(
            {userId: user._id!, pauseReason: "entitlement"},
            {$set: {status: "active", nextRunAt: new Date(), updatedAt: new Date()}, $unset: {pauseReason: ""}}
        )
        if (resumed.modifiedCount) {
            logger.info(
                "Creem.applySubscription",
                `User ${user._id!.toHexString()}`,
                `Resumed tasks ${resumed.modifiedCount}`
            )
        }
        return
    }
    const retainedTask = await db.syncTasks
        .find({userId: user._id!, mode: {$ne: "account"}})
        .sort({createdAt: 1})
        .limit(1)
        .next()
    const paused = await db.syncTasks.updateMany(
        {userId: user._id!, ...(retainedTask?._id ? {_id: {$ne: retainedTask._id}} : {})},
        {$set: {status: "paused", pauseReason: "entitlement", updatedAt: new Date()}}
    )
    if (paused.modifiedCount) {
        logger.warn(
            "Creem.applySubscription",
            `User ${user._id!.toHexString()}`,
            `Paused tasks ${paused.modifiedCount}`
        )
    }
    if (retainedTask && retainedTask.pauseReason === "entitlement") {
        await db.syncTasks.updateOne(
            {_id: retainedTask._id},
            {
                $set: {
                    status: "active",
                    nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    updatedAt: new Date()
                },
                $unset: {pauseReason: ""}
            }
        )
    }
}

export async function processCreemEvent(event: WebhookEventEntity): Promise<void> {
    const db = await collections()
    try {
        await db.webhookEvents.insertOne({eventId: event.id, type: event.eventType, processedAt: new Date()})
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 11000) {
            logger.info("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, "Duplicate ignored")
            return
        }
        logger.error("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, error)
        throw error
    }

    logger.info("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`)
    try {
        await applyCreemEvent(event)
        logger.info("Creem.processEvent", `Event ${event.id}`, "Processed")
    } catch (error) {
        await db.webhookEvents.deleteOne({eventId: event.id})
        logger.error("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, error)
        throw error
    }
}

async function applyCreemEvent(event: WebhookEventEntity): Promise<void> {
    const db = await collections()
    if (event.eventType === "checkout.completed") {
        const userId = event.object.metadata?.userId
        const customer = event.object.customer
        const subscription = event.object.subscription
        if (typeof userId === "string" && customer && subscription) {
            const creemCustomerId = typeof customer === "string" ? customer : customer.id
            const creemSubscriptionId = typeof subscription === "string" ? subscription : subscription.id
            await db.users.updateOne(
                {_id: new ObjectId(userId)},
                {$set: {creemCustomerId, creemSubscriptionId, updatedAt: new Date()}}
            )
            await applySubscription(
                typeof subscription === "string" ? await getCreem().subscriptions.get(subscription) : subscription
            )
        }
        return
    }

    switch (event.eventType) {
        case "subscription.active":
            await applySubscription(event.object, "active")
            break
        case "subscription.trialing":
            await applySubscription(event.object, "trialing")
            break
        case "subscription.canceled":
            await applySubscription(event.object, "canceled")
            break
        case "subscription.scheduled_cancel":
            await applySubscription(event.object, "scheduled_cancel")
            break
        case "subscription.paid":
            await applySubscription(event.object, "active")
            break
        case "subscription.expired":
            await applySubscription(event.object, "expired")
            break
        case "subscription.unpaid":
            await applySubscription(event.object, "unpaid")
            break
        case "subscription.update":
            await applySubscription(event.object)
            break
        case "subscription.past_due":
            await applySubscription(event.object, "past_due")
            break
        case "subscription.paused":
            await applySubscription(event.object, "paused")
    }
}
