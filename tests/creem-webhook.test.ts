import {afterAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {WebhookEventEntity} from "creem/models/components"
import type {UserDocument, WebhookEventDocument} from "../shared/types/domain"
import * as collectionsModule from "../server/data/collections"
import {processCreemEvent} from "../server/domain/billing/creem"

const webhookRows = new Map<string, WebhookEventDocument>()
let applyCalls = 0
let failNextApply = false

const db = {
    webhookEvents: {
        insertOne: async (doc: WebhookEventDocument) => {
            if (webhookRows.has(doc.eventId)) {
                throw {code: 11000}
            }
            webhookRows.set(doc.eventId, {...doc})
            return {acknowledged: true, insertedId: new ObjectId()}
        },
        findOne: async (filter: {eventId: string}) => webhookRows.get(filter.eventId),
        updateOne: async (filter: {eventId: string}, update: {$set: Partial<WebhookEventDocument>}) => {
            const doc = webhookRows.get(filter.eventId)
            if (doc) {
                webhookRows.set(filter.eventId, {...doc, ...update.$set})
            }
            return {acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0}
        }
    },
    users: {
        findOneAndUpdate: async () => {
            applyCalls += 1
            if (failNextApply) {
                failNextApply = false
                throw new Error("transient database failure")
            }
            return {_id: new ObjectId(), tier: "pro"}
        }
    },
    syncTasks: {
        updateMany: async () => ({acknowledged: true, matchedCount: 0, modifiedCount: 0})
    }
}

// A spy instead of mock.module, which would leak the fake database into every later test file.
const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as unknown as Awaited<ReturnType<typeof collectionsModule.collections>>)
afterAll(() => collectionsSpy.mockRestore())

function subscriptionEvent(id: string): WebhookEventEntity {
    return {
        id,
        eventType: "subscription.active",
        object: {id: "sub-1", customer: "cus-1", status: "active"}
    } as unknown as WebhookEventEntity
}

describe("Creem webhook deduplication", () => {
    beforeEach(() => {
        webhookRows.clear()
        applyCalls = 0
        failNextApply = false
    })

    test("a failed event can be retried instead of being dropped as a duplicate", async () => {
        const event = subscriptionEvent("evt-retry")

        failNextApply = true
        await expect(processCreemEvent(event)).rejects.toThrow("transient database failure")
        expect(webhookRows.get("evt-retry")?.status).toBe("failed")

        await processCreemEvent(event)
        expect(applyCalls).toBe(2)
        expect(webhookRows.get("evt-retry")?.status).toBe("processed")
    })

    test("a processed event is ignored on redelivery", async () => {
        const event = subscriptionEvent("evt-duplicate")

        await processCreemEvent(event)
        await processCreemEvent(event)

        expect(applyCalls).toBe(1)
        expect(webhookRows.get("evt-duplicate")?.status).toBe("processed")
    })
})
