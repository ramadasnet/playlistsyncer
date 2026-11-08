import {describe, expect, test} from "bun:test"
import {runMigrations} from "../server/data/migrations"

type Document = Record<string, unknown>

function memoryCollection(documents: Document[] = []) {
    const matches = (document: Document, filter: Document) =>
        Object.entries(filter).every(([key, value]) => {
            if (value && typeof value === "object" && "$in" in value) return (value.$in as unknown[]).includes(document[key])
            if (value && typeof value === "object" && "$gt" in value) return Number(document[key]) > Number(value.$gt)
            return document[key] === value
        })
    const apply = (document: Document, update: {$set?: Document; $unset?: Document}) => {
        Object.assign(document, update.$set)
        for (const key of Object.keys(update.$unset || {})) delete document[key]
    }
    return {
        documents,
        findOne: async (filter: Document) => documents.find((document) => matches(document, filter)) ?? null,
        async updateMany(filter: Document, update: {$set?: Document; $unset?: Document}) {
            const matching = documents.filter((document) => matches(document, filter))
            matching.forEach((document) => apply(document, update))
            return {modifiedCount: matching.length}
        },
        async updateOne(filter: Document, update: {$set?: Document}, options: {upsert?: boolean}) {
            let document = documents.find((document) => matches(document, filter))
            if (!document && options.upsert) {
                document = {...filter}
                documents.push(document)
            }
            if (document) apply(document, update)
        }
    }
}

function fixture() {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const due = new Date(Date.now() - 60_000)
    const users = memoryCollection([{_id: "listener", tier: "free", creemCustomerId: "customer", creemSubscriptionId: "subscription", email: "listener@example.com", weeklySyncSummaryEnabled: true}])
    const tasks = memoryCollection([
        {_id: "locked", status: "paused", pauseReason: "entitlement", nextRunAt: tomorrow},
        {_id: "paused", status: "paused", pauseReason: "user", nextRunAt: tomorrow},
        {_id: "scheduled", status: "active", nextRunAt: tomorrow},
        {_id: "due", status: "needs_attention", nextRunAt: due}
    ])
    const completed = memoryCollection()
    let webhookExists = true
    let failDrop = false
    const database = {
        collection: (name: string) => {
            if (name === "users") return users
            if (name === "syncTasks") return tasks
            if (name === "migrations") return completed
            if (name === "webhookEvents")
                return {
                    drop: async () => {
                        if (failDrop) throw new Error("Database unavailable")
                        webhookExists = false
                    }
                }
            throw new Error(`Unexpected collection ${name}`)
        },
        listCollections: () => ({toArray: async () => (webhookExists ? [{name: "webhookEvents"}] : [])})
    }
    return {
        database,
        users,
        tasks,
        completed,
        due,
        tomorrow,
        webhookExists: () => webhookExists,
        setFailDrop: (value: boolean) => {
            failDrop = value
        }
    }
}

describe("database maintenance", () => {
    test("cleans legacy billing data and resumes only access-locked tasks once", async () => {
        const store = fixture()
        await runMigrations(store.database as never)

        expect(store.users.documents[0]).toEqual({_id: "listener", email: "listener@example.com", weeklySyncSummaryEnabled: true})
        const [locked, paused, scheduled, due] = store.tasks.documents
        expect(locked).toMatchObject({status: "active"})
        expect(locked).not.toHaveProperty("pauseReason")
        expect(paused).toEqual({_id: "paused", status: "paused", pauseReason: "user", nextRunAt: store.tomorrow})
        expect(Number(scheduled?.nextRunAt)).toBeLessThan(store.tomorrow.getTime())
        expect(due?.nextRunAt).toBe(store.due)
        expect(store.webhookExists()).toBe(false)
        expect(store.completed.documents).toHaveLength(1)

        locked!.status = "paused"
        locked!.pauseReason = "user"
        await runMigrations(store.database as never)
        expect(locked).toMatchObject({status: "paused", pauseReason: "user"})
    })

    test("does not record a failed cleanup and can retry it", async () => {
        const store = fixture()
        store.setFailDrop(true)
        await expect(runMigrations(store.database as never)).rejects.toThrow("Database unavailable")
        expect(store.completed.documents).toHaveLength(0)

        store.setFailDrop(false)
        await runMigrations(store.database as never)
        expect(store.webhookExists()).toBe(false)
        expect(store.completed.documents).toHaveLength(1)
    })
})
