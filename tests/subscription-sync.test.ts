import {afterAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {CreemError} from "creem/models/errors"
import type {SubscriptionEntity} from "creem/models/components"
import {ObjectId, type Filter, type UpdateFilter} from "mongodb"
import type {UserDocument} from "../shared/types/domain"
import * as collectionsModule from "../server/data/collections"
import {applySubscription} from "../server/domain/billing/creem"
import {syncCreemSubscriptions, type CreemSubscriptionSource} from "../server/domain/billing/subscription-sync"

const users: UserDocument[] = []
const productId = "prod_pro"

const db = {
    users: {
        findOne: async (filter: Filter<UserDocument>) => users.find((user) => matches(user, filter)),
        find: (filter: Filter<UserDocument>) => ({
            limit(count: number) {
                return {toArray: async () => users.filter((user) => matches(user, filter)).slice(0, count)}
            },
            toArray: async () => users.filter((user) => matches(user, filter))
        }),
        updateOne: async (filter: Filter<UserDocument>, update: UpdateFilter<UserDocument>) => {
            const user = users.find((item) => matches(item, filter))
            if (!user) return {matchedCount: 0, modifiedCount: 0}
            const change = update as {$set?: Partial<UserDocument>; $unset?: Record<string, "">}
            Object.assign(user, change.$set)
            for (const key of Object.keys(change.$unset ?? {})) delete user[key as keyof UserDocument]
            return {matchedCount: 1, modifiedCount: 1}
        }
    },
    syncTasks: {
        find: () => ({sort: () => ({limit: () => ({next: async () => null})})}),
        updateMany: async () => ({modifiedCount: 0}),
        updateOne: async () => ({modifiedCount: 0})
    }
}

const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as unknown as Awaited<ReturnType<typeof collectionsModule.collections>>)
afterAll(() => collectionsSpy.mockRestore())

function matches(user: UserDocument, filter: Filter<UserDocument>): boolean {
    const query = filter as {
        _id?: ObjectId
        creemCustomerId?: string
        email?: string
        creemSubscriptionId?: {$type?: string; $nin?: string[]}
    }
    if (query._id && !user._id?.equals(query._id)) return false
    if (query.creemCustomerId !== undefined && user.creemCustomerId !== query.creemCustomerId) return false
    if (query.email !== undefined && user.email !== query.email) return false
    const subscription = query.creemSubscriptionId
    if (subscription && typeof subscription === "object") {
        if (subscription.$type === "string" && typeof user.creemSubscriptionId !== "string") return false
        if (subscription.$nin?.includes(user.creemSubscriptionId ?? "")) return false
    }
    return true
}

function addUser(fields: Partial<UserDocument> = {}): UserDocument {
    const user: UserDocument = {
        _id: new ObjectId(),
        displayName: "Subscriber",
        tier: "free",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...fields
    }
    users.push(user)
    return user
}

function subscription(overrides: Partial<SubscriptionEntity> = {}): SubscriptionEntity {
    return {
        id: "sub-1",
        mode: "test",
        object: "subscription",
        product: productId,
        customer: "cus-1",
        collectionMethod: "charge_automatically",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        ...overrides
    } as SubscriptionEntity
}

function page(items: SubscriptionEntity[], nextPage: number | null): {items: SubscriptionEntity[]; pagination: {nextPage: number | null}} {
    return {items, pagination: {nextPage}}
}

function notFound(): CreemError {
    return new CreemError("missing", {response: new Response(null, {status: 404}), request: new Request("https://test-api.creem.io/v1/subscriptions/missing"), body: ""})
}

describe("subscription sync", () => {
    beforeEach(() => users.splice(0))

    test("writes status and payment dates, then leaves an unchanged account alone", async () => {
        const user = addUser({email: "listener@example.com", creemCustomerId: "cus-1", creemSubscriptionStatus: "canceled", tier: "free", creemNextTransactionDate: new Date("2026-02-01T00:00:00.000Z")})
        const lastPaid = new Date("2026-09-01T00:00:00.000Z")
        const periodEnd = new Date("2027-09-01T00:00:00.000Z")
        const source: CreemSubscriptionSource = {
            search: async () =>
                page(
                    [
                        subscription({
                            status: "active",
                            lastTransactionDate: lastPaid,
                            currentPeriodStartDate: lastPaid,
                            currentPeriodEndDate: periodEnd
                        })
                    ],
                    null
                ),
            get: async () => {
                throw new Error("stored subscription should already be listed")
            }
        }

        const first = await syncCreemSubscriptions({source, productId})
        expect(first).toMatchObject({checked: 1, updated: 1, unchanged: 0, unmatched: 0, missing: 0, failed: 0, stopped: false})
        expect(user.tier).toBe("pro")
        expect(user.creemSubscriptionId).toBe("sub-1")
        expect(user.creemSubscriptionStatus).toBe("active")
        expect(user.creemLastTransactionDate).toEqual(lastPaid)
        expect(user.creemCurrentPeriodEndDate).toEqual(periodEnd)
        expect(user.creemNextTransactionDate).toBeUndefined()

        const updatedAt = user.updatedAt
        const second = await syncCreemSubscriptions({source, productId})
        expect(second).toMatchObject({updated: 0, unchanged: 1})
        expect(user.updatedAt).toEqual(updatedAt)
    })

    test("keeps the paid subscription when an older canceled one belongs to the same customer", async () => {
        const user = addUser({creemCustomerId: "cus-1", tier: "free"})
        const source: CreemSubscriptionSource = {
            search: async (pageNumber) => {
                if (pageNumber === 1) {
                    return page([subscription({id: "sub-old", status: "canceled", updatedAt: new Date("2026-08-01T00:00:00.000Z")})], 2)
                }
                return page([subscription({id: "sub-new", status: "active", updatedAt: new Date("2026-01-01T00:00:00.000Z")})], null)
            },
            get: async () => {
                throw new Error("both subscriptions were listed")
            }
        }

        const result = await syncCreemSubscriptions({source, productId, pageSize: 1})
        expect(result).toMatchObject({checked: 2, updated: 1, unchanged: 0})
        expect(user.creemSubscriptionId).toBe("sub-new")
        expect(user.creemSubscriptionStatus).toBe("active")
        expect(user.tier).toBe("pro")
    })

    test("links an account from checkout metadata or a single matching email", async () => {
        const byMetadata = addUser({email: "meta@example.com"})
        const byEmail = addUser({email: "paid@example.com"})
        const source: CreemSubscriptionSource = {
            search: async () =>
                page(
                    [
                        subscription({id: "sub-meta", customer: "cus-meta", metadata: {userId: byMetadata._id!.toHexString()}}),
                        subscription({
                            id: "sub-email",
                            customer: {id: "cus-email", email: "Paid@Example.com", mode: "test", object: "customer", country: "NL", createdAt: new Date(), updatedAt: new Date()}
                        })
                    ],
                    null
                ),
            get: async () => {
                throw new Error("listed subscriptions do not need a lookup")
            }
        }

        const result = await syncCreemSubscriptions({source, productId})
        expect(result).toMatchObject({updated: 2, unmatched: 0})
        expect(byMetadata.creemCustomerId).toBe("cus-meta")
        expect(byMetadata.tier).toBe("pro")
        expect(byEmail.creemCustomerId).toBe("cus-email")
        expect(byEmail.tier).toBe("pro")
    })

    test("ignores subscriptions for a different product", async () => {
        const user = addUser({creemCustomerId: "cus-1", tier: "free"})
        const source: CreemSubscriptionSource = {
            search: async () => page([subscription({product: "prod_other"})], null),
            get: async () => {
                throw new Error("other products are not looked up")
            }
        }

        const result = await syncCreemSubscriptions({source, productId})
        expect(result.checked).toBe(0)
        expect(user.tier).toBe("free")
        expect(user.creemSubscriptionStatus).toBeUndefined()
    })

    test("marks a stored subscription canceled when Creem no longer has it", async () => {
        const user = addUser({
            creemCustomerId: "cus-1",
            creemSubscriptionId: "sub-gone",
            creemSubscriptionStatus: "active",
            tier: "pro",
            weeklySyncSummaryEnabled: true,
            creemNextTransactionDate: new Date("2027-01-01T00:00:00.000Z")
        })
        const source: CreemSubscriptionSource = {
            search: async () => page([], null),
            get: async () => {
                throw notFound()
            }
        }

        const result = await syncCreemSubscriptions({source, productId})
        expect(result).toMatchObject({missing: 1, updated: 1, failed: 0})
        expect(user.creemSubscriptionStatus).toBe("canceled")
        expect(user.tier).toBe("free")
        expect(user.weeklySyncSummaryEnabled).toBe(false)
        expect(user.creemNextTransactionDate).toBeUndefined()
        expect(user.creemSubscriptionId).toBe("sub-gone")
    })

    test("does not cancel stored subscriptions when the Creem list stops early", async () => {
        const user = addUser({creemCustomerId: "cus-1", creemSubscriptionId: "sub-local", creemSubscriptionStatus: "active", tier: "pro"})
        let pages = 0
        const source: CreemSubscriptionSource = {
            search: async () => {
                pages++
                return page([subscription({id: "sub-listed", customer: "cus-other"})], 2)
            },
            get: async () => {
                throw new Error("lookup must wait until every page is read")
            }
        }

        const result = await syncCreemSubscriptions({source, productId, stopping: () => pages > 0})
        expect(pages).toBe(1)
        expect(result.stopped).toBe(true)
        expect(result.missing).toBe(0)
        expect(user.creemSubscriptionStatus).toBe("active")
        expect(user.tier).toBe("pro")
    })

    test("subscription events update payment dates they include and leave the others in place", async () => {
        const next = new Date("2027-09-01T00:00:00.000Z")
        const last = new Date("2026-10-01T00:00:00.000Z")
        const user = addUser({
            creemCustomerId: "cus-1",
            creemSubscriptionId: "sub-1",
            creemSubscriptionStatus: "active",
            tier: "pro",
            creemNextTransactionDate: next,
            creemCanceledAt: new Date("2026-05-01T00:00:00.000Z")
        })

        const outcome = await applySubscription({id: "sub-1", customer: "cus-1", status: "active", lastTransactionDate: last, canceledAt: null})
        expect(outcome).toBe("updated")
        expect(user.creemLastTransactionDate).toEqual(last)
        expect(user.creemNextTransactionDate).toEqual(next)
        expect(user.creemCanceledAt).toBeUndefined()
    })
})
