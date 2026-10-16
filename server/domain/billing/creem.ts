// Integrate Creem subscriptions with local entitlements and task locks.
import {Creem, HTTPClient} from "creem"
import type {SubscriptionEntity, WebhookEventEntity} from "creem/models/components"
import {ObjectId} from "mongodb"
import type {UserDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {getServerConfig, requireConfig} from "../../utils/config"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {isDuplicateKeyError} from "../../utils/mongodb"
import {applyTaskEntitlement} from "./task-entitlement"

let creemClient: Creem | undefined

// Lazily initialize the configured Creem client.
export function getCreem(): Creem {
    if (!creemClient) {
        const server = getServerConfig().creemServer
        // Route SDK requests through the shared retry policy; the SDK's own retries stay disabled.
        const httpClient = new HTTPClient({fetcher: (input, init) => fetchWithRetry(input instanceof Request ? input : new Request(input, init), {}, {label: "Creem.request"})})
        creemClient = new Creem({apiKey: requireConfig("creemApiKey"), server, httpClient})
        logger.info("Creem.init", `Server ${server}`)
    }
    return creemClient
}

type CreemSubscription = Pick<SubscriptionEntity, "id" | "customer" | "status"> & Partial<Pick<SubscriptionEntity, "updatedAt" | "lastTransactionDate" | "nextTransactionDate" | "currentPeriodStartDate" | "currentPeriodEndDate" | "canceledAt">>
type ApplySubscriptionOptions = {
    userId?: ObjectId
    replaceDates?: boolean
    // Skip the write when the account already stores a Creem update newer than this snapshot.
    ifNotNewerThan?: Date
    // Skip the write when the account no longer has this subscription id and Creem update time.
    onlyIfUnchanged?: {subscriptionId: string; subscriptionUpdatedAt?: Date}
}
const paidStatuses = new Set(["active", "trialing", "scheduled_cancel"])
const subscriptionDateFields = [
    ["lastTransactionDate", "creemLastTransactionDate"],
    ["nextTransactionDate", "creemNextTransactionDate"],
    ["currentPeriodStartDate", "creemCurrentPeriodStartDate"],
    ["currentPeriodEndDate", "creemCurrentPeriodEndDate"],
    ["canceledAt", "creemCanceledAt"]
] as const

// Identify subscription states that grant PRO access.
export function hasPaidEntitlement(status: string): boolean {
    return paidStatuses.has(status)
}

function customerId(customer: CreemSubscription["customer"]): string {
    return typeof customer === "string" ? customer : customer.id
}

function sameInstant(left: unknown, right: Date | null): boolean {
    const leftTime = left instanceof Date ? left.getTime() : undefined
    const rightTime = right instanceof Date ? right.getTime() : undefined
    return leftTime === rightTime
}

// A Date is stored, null clears the stored date, and undefined leaves it alone.
function dateUpdate(subscription: CreemSubscription, key: (typeof subscriptionDateFields)[number][0], replaceMissing: boolean): Date | null | undefined {
    const value = subscription[key]
    if (value instanceof Date) return value
    if (value === null || replaceMissing) return null
    return undefined
}

function keepsNewerSubscription(user: UserDocument, snapshotUpdatedAt: Date | undefined): boolean {
    return snapshotUpdatedAt instanceof Date && user.creemSubscriptionUpdatedAt instanceof Date && user.creemSubscriptionUpdatedAt.getTime() > snapshotUpdatedAt.getTime()
}

function subscriptionUnchanged(user: UserDocument, expected: {subscriptionId: string; subscriptionUpdatedAt?: Date}): boolean {
    return user.creemSubscriptionId === expected.subscriptionId && sameInstant(user.creemSubscriptionUpdatedAt, expected.subscriptionUpdatedAt ?? null)
}

/**
 * Persist subscription status and payment dates, then reconcile task entitlement.
 * Dates included on the subscription replace the stored ones. A full Creem read can also clear dates the payload omits.
 * A snapshot older than the stored Creem update time is left unused, so a payment webhook is not overwritten.
 * @param options.userId Account to update when it is not yet linked by Creem customer id.
 * @param options.replaceDates Clear stored dates that this subscription does not include.
 * @param options.ifNotNewerThan Creem update time of the snapshot. A newer stored update wins.
 * @param options.onlyIfUnchanged Subscription id and Creem update time that must still be stored.
 */
export async function applySubscription(subscription: CreemSubscription, status: string = subscription.status, options?: ApplySubscriptionOptions): Promise<"updated" | "unchanged" | "missing" | "skipped"> {
    const isPaid = hasPaidEntitlement(status)
    const db = await collections()
    const customer = customerId(subscription.customer)
    const user = await db.users.findOne(options?.userId ? {_id: options.userId} : {creemCustomerId: customer})
    if (!user?._id) {
        logger.warn("Creem.applySubscription", `Customer ${customer}`, "User not found")
        return "missing"
    }
    if (keepsNewerSubscription(user, options?.ifNotNewerThan)) {
        logger.info("Creem.applySubscription", `User ${user._id.toHexString()}`, `Subscription ${subscription.id}`, "Kept a newer subscription update")
        return "skipped"
    }
    if (options?.onlyIfUnchanged && !subscriptionUnchanged(user, options.onlyIfUnchanged)) {
        logger.info("Creem.applySubscription", `User ${user._id.toHexString()}`, `Subscription ${subscription.id}`, "Kept a subscription change made after the missing check")
        return "skipped"
    }

    const set: Partial<UserDocument> = {
        creemSubscriptionId: subscription.id,
        creemSubscriptionStatus: status,
        tier: isPaid ? "pro" : "free"
    }
    if (customer) set.creemCustomerId = customer
    if (!isPaid) set.weeklySyncSummaryEnabled = false
    if (subscription.updatedAt instanceof Date) set.creemSubscriptionUpdatedAt = subscription.updatedAt

    let changed = false
    for (const [key, value] of Object.entries(set) as [keyof UserDocument, unknown][]) {
        if (value instanceof Date) {
            if (!sameInstant(user[key], value)) changed = true
        } else if (user[key] !== value) changed = true
    }
    const unset: {[key: string]: ""} = {}
    for (const [sourceKey, storedKey] of subscriptionDateFields) {
        const value = dateUpdate(subscription, sourceKey, options?.replaceDates ?? false)
        if (value === undefined) continue
        if (value instanceof Date) {
            set[storedKey] = value
            if (!sameInstant(user[storedKey], value)) changed = true
        } else {
            unset[storedKey] = ""
            if (user[storedKey] instanceof Date) changed = true
        }
    }

    if (changed) {
        set.updatedAt = new Date()
        const writeFilter: {
            _id: ObjectId
            creemSubscriptionId?: string
            creemSubscriptionUpdatedAt?: Date | {$exists: false}
            $or?: Array<{creemSubscriptionUpdatedAt: {$exists: false} | {$lte: Date}}>
        } = {_id: user._id}
        if (options?.ifNotNewerThan instanceof Date) {
            writeFilter.$or = [{creemSubscriptionUpdatedAt: {$exists: false}}, {creemSubscriptionUpdatedAt: {$lte: options.ifNotNewerThan}}]
        }
        if (options?.onlyIfUnchanged) {
            writeFilter.creemSubscriptionId = options.onlyIfUnchanged.subscriptionId
            writeFilter.creemSubscriptionUpdatedAt = options.onlyIfUnchanged.subscriptionUpdatedAt instanceof Date ? options.onlyIfUnchanged.subscriptionUpdatedAt : {$exists: false}
        }
        const written = await db.users.updateOne(writeFilter, Object.keys(unset).length ? {$set: set, $unset: unset} : {$set: set})
        if (!written.matchedCount) {
            logger.info("Creem.applySubscription", `User ${user._id.toHexString()}`, `Subscription ${subscription.id}`, "Kept a newer subscription update")
            return "skipped"
        }
        logger.info("Creem.applySubscription", `User ${user._id.toHexString()}`, `Subscription ${subscription.id}`, `Status ${status}`, `Tier ${isPaid ? "pro" : "free"}`)
    }
    // Run even when the subscription row already matches, so a retry can finish task changes the previous attempt missed.
    await applyTaskEntitlement({...user, ...set})
    return changed ? "updated" : "unchanged"
}

// Deduplicate and process one verified Creem webhook event.
export async function processCreemEvent(event: WebhookEventEntity): Promise<void> {
    const db = await collections()
    try {
        await db.webhookEvents.insertOne({eventId: event.id, type: event.eventType, status: "processing", processedAt: new Date()})
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            const existing = await db.webhookEvents.findOne({eventId: event.id})
            if (!existing || existing.status === "processed" || !existing.status) {
                logger.info("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, "Duplicate ignored")
                return
            }
            logger.info("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, "Retrying after a failed attempt")
        } else {
            logger.error("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, error)
            throw error
        }
    }

    logger.info("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`)
    try {
        await applyCreemEvent(event)
        await db.webhookEvents.updateOne({eventId: event.id}, {$set: {status: "processed", processedAt: new Date()}})
        logger.info("Creem.processEvent", `Event ${event.id}`, "Processed")
    } catch (error) {
        // Mark the attempt as failed so provider retries can re-apply instead of being mistaken for duplicates.
        await db.webhookEvents.updateOne({eventId: event.id}, {$set: {status: "failed"}})
        logger.error("Creem.processEvent", `Event ${event.id}`, `Type ${event.eventType}`, error)
        throw error
    }
}

// Map each supported Creem event type to the local subscription update.
async function applyCreemEvent(event: WebhookEventEntity): Promise<void> {
    const db = await collections()
    if (event.eventType === "checkout.completed") {
        const userId = event.object.metadata?.userId
        const customer = event.object.customer
        const subscription = event.object.subscription
        if (typeof userId === "string" && customer && subscription) {
            const creemCustomerId = typeof customer === "string" ? customer : customer.id
            const creemSubscriptionId = typeof subscription === "string" ? subscription : subscription.id
            await db.users.updateOne({_id: new ObjectId(userId)}, {$set: {creemCustomerId, creemSubscriptionId, updatedAt: new Date()}})
            await applySubscription(typeof subscription === "string" ? await getCreem().subscriptions.get(subscription) : subscription)
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
