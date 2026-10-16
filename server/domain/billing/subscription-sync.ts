// Reconcile local subscription status and payment dates with Creem.
import {CreemError} from "creem/models/errors"
import type {SubscriptionEntity} from "creem/models/components"
import {ObjectId} from "mongodb"
import type {UserDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {isShuttingDown} from "../../utils/shutdown"
import {applySubscription, hasPaidEntitlement} from "./creem"

export const subscriptionSyncPageSize = 100

export interface SubscriptionSyncResult {
    checked: number
    updated: number
    unchanged: number
    unmatched: number
    missing: number
    failed: number
    stopped: boolean
}

export interface CreemSubscriptionSource {
    // One page of Creem subscriptions. nextPage is null on the last page.
    search(pageNumber: number, pageSize: number): Promise<{items: SubscriptionEntity[]; pagination: {nextPage: number | null}}>
    get(subscriptionId: string): Promise<SubscriptionEntity>
}

function customerId(customer: SubscriptionEntity["customer"]): string {
    return typeof customer === "string" ? customer : customer.id
}

function productIdOf(product: SubscriptionEntity["product"]): string {
    return typeof product === "string" ? product : product.id
}

function customerEmail(customer: SubscriptionEntity["customer"]): string | undefined {
    if (typeof customer === "string") return undefined
    const email = customer.email.trim().toLowerCase()
    return email || undefined
}

function updatedAt(subscription: SubscriptionEntity): number {
    return subscription.updatedAt instanceof Date ? subscription.updatedAt.getTime() : 0
}

// Keep the subscription that still grants PRO. Otherwise keep the most recently updated one.
function preferSubscription(current: SubscriptionEntity | undefined, candidate: SubscriptionEntity): SubscriptionEntity {
    if (!current) return candidate
    const currentPaid = hasPaidEntitlement(current.status)
    const candidatePaid = hasPaidEntitlement(candidate.status)
    if (candidatePaid !== currentPaid) return candidatePaid ? candidate : current
    return updatedAt(candidate) >= updatedAt(current) ? candidate : current
}

function canLink(user: UserDocument, customer: string): boolean {
    return !user.creemCustomerId || user.creemCustomerId === customer
}

function isMissingSubscription(error: unknown): boolean {
    return error instanceof CreemError && error.statusCode === 404
}

// Match a Creem subscription to the account that checked out, when one can be identified.
async function findSubscriptionUser(subscription: SubscriptionEntity): Promise<UserDocument | null> {
    const db = await collections()
    const customer = customerId(subscription.customer)
    const linked = customer ? await db.users.findOne({creemCustomerId: customer}) : null
    if (linked) return linked

    const metadataUserId = subscription.metadata?.userId
    if (typeof metadataUserId === "string" && ObjectId.isValid(metadataUserId)) {
        const byId = await db.users.findOne({_id: new ObjectId(metadataUserId)})
        if (byId && canLink(byId, customer)) return byId
    }

    const email = customerEmail(subscription.customer)
    if (!email) return null
    const matches = await db.users.find({email}).limit(2).toArray()
    if (matches.length === 1 && matches[0] && canLink(matches[0], customer)) return matches[0]
    return null
}

/**
 * Reads Creem subscriptions and writes status and payment dates onto the matching accounts.
 * A Creem list that fails is left unapplied, so a partial read cannot mark live subscriptions canceled.
 * @param input.source Creem list and lookup.
 * @param input.productId Only subscriptions for this product are applied.
 * @param input.stopping Returns true when the process should stop before the next page or account. Defaults to process shutdown.
 */
export async function syncCreemSubscriptions(input: {source: CreemSubscriptionSource; productId: string; pageSize?: number; stopping?: () => boolean}): Promise<SubscriptionSyncResult> {
    const stopping = input.stopping ?? isShuttingDown
    const pageSize = input.pageSize ?? subscriptionSyncPageSize
    const result: SubscriptionSyncResult = {checked: 0, updated: 0, unchanged: 0, unmatched: 0, missing: 0, failed: 0, stopped: false}
    const seen = new Set<string>()
    const chosen = new Map<string, SubscriptionEntity>()
    const visited = new Set<number>()
    let pageNumber = 1
    let listComplete = false

    while (true) {
        if (stopping()) {
            result.stopped = true
            break
        }
        if (visited.has(pageNumber)) {
            logger.warn("Billing.subscriptionSync", `Page ${pageNumber} repeated; stored subscriptions were not checked`)
            break
        }
        visited.add(pageNumber)
        const page = await input.source.search(pageNumber, pageSize)
        for (const subscription of page.items) {
            seen.add(subscription.id)
            if (productIdOf(subscription.product) !== input.productId) continue
            result.checked++
            const customer = customerId(subscription.customer)
            chosen.set(customer, preferSubscription(chosen.get(customer), subscription))
        }
        const nextPage = page.pagination.nextPage
        if (nextPage == null || nextPage === pageNumber) {
            listComplete = true
            break
        }
        pageNumber = nextPage
    }

    if (!listComplete) {
        if (result.stopped) logger.warn("Billing.subscriptionSync", "Stopped before every Creem page was read")
        return result
    }

    const db = await collections()
    const missingUsers: {userId: ObjectId; subscriptionId: string; customerId?: string; subscriptionUpdatedAt?: Date}[] = []
    const local = await db.users.find({creemSubscriptionId: {$type: "string", $nin: [...seen]}}).toArray()
    for (const user of local) {
        if (stopping()) {
            result.stopped = true
            break
        }
        if (!user.creemSubscriptionId) continue
        try {
            const subscription = await input.source.get(user.creemSubscriptionId)
            seen.add(subscription.id)
            if (productIdOf(subscription.product) !== input.productId) continue
            result.checked++
            const customer = customerId(subscription.customer)
            chosen.set(customer, preferSubscription(chosen.get(customer), subscription))
        } catch (error) {
            if (isMissingSubscription(error) && user._id && user.creemSubscriptionId) {
                missingUsers.push({userId: user._id, subscriptionId: user.creemSubscriptionId, customerId: user.creemCustomerId, subscriptionUpdatedAt: user.creemSubscriptionUpdatedAt})
                continue
            }
            result.failed++
            logger.error("Billing.subscriptionSync", `Subscription ${user.creemSubscriptionId}`, error)
        }
    }

    // The list is complete, so a later page cannot overturn a status written here. Downgrades still wait until every stored id is checked.
    if (result.stopped || stopping()) {
        result.stopped = true
        return result
    }
    const byUser = new Map<string, {user: UserDocument; subscription: SubscriptionEntity}>()
    for (const subscription of chosen.values()) {
        if (stopping()) {
            result.stopped = true
            break
        }
        const customer = customerId(subscription.customer)
        try {
            const user = await findSubscriptionUser(subscription)
            if (!user?._id) {
                result.unmatched++
                logger.warn("Billing.subscriptionSync", `Subscription ${subscription.id}`, `Customer ${customer}`, "No matching user")
                continue
            }
            const key = user._id.toHexString()
            const existing = byUser.get(key)
            byUser.set(key, {user, subscription: preferSubscription(existing?.subscription, subscription)})
        } catch (error) {
            result.failed++
            logger.error("Billing.subscriptionSync", `Subscription ${subscription.id}`, `Customer ${customer}`, error)
        }
    }
    if (result.stopped) return result

    const appliedUserIds = new Set<string>()
    for (const {user, subscription} of byUser.values()) {
        if (stopping()) {
            result.stopped = true
            break
        }
        try {
            const outcome = await applySubscription(subscription, subscription.status, {userId: user._id, replaceDates: true, ifNotNewerThan: subscription.updatedAt})
            if (outcome === "skipped") {
                result.unchanged++
                continue
            }
            if (outcome === "missing") {
                result.unmatched++
                continue
            }
            appliedUserIds.add(user._id!.toHexString())
            result[outcome]++
        } catch (error) {
            result.failed++
            logger.error("Billing.subscriptionSync", `Subscription ${subscription.id}`, `Customer ${customerId(subscription.customer)}`, error)
        }
    }
    if (result.stopped) return result
    for (const user of missingUsers) {
        if (stopping()) {
            result.stopped = true
            break
        }
        if (appliedUserIds.has(user.userId.toHexString())) continue
        try {
            const outcome = await applySubscription({id: user.subscriptionId, customer: user.customerId ?? "", status: "canceled"}, "canceled", {
                userId: user.userId,
                replaceDates: true,
                onlyIfUnchanged: {subscriptionId: user.subscriptionId, subscriptionUpdatedAt: user.subscriptionUpdatedAt}
            })
            if (outcome === "skipped") {
                result.unchanged++
                continue
            }
            result.missing++
            logger.warn("Billing.subscriptionSync", `User ${user.userId.toHexString()}`, `Subscription ${user.subscriptionId}`, "Creem has no subscription; marking it canceled")
            if (outcome === "missing") result.unmatched++
            else result[outcome]++
        } catch (error) {
            result.failed++
            logger.error("Billing.subscriptionSync", `User ${user.userId.toHexString()}`, `Subscription ${user.subscriptionId}`, error)
        }
    }
    return result
}
