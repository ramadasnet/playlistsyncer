import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {SyncTaskDocument, UserDocument} from "../shared/types/domain"
import * as collectionsModule from "../server/data/collections"
import * as session from "../server/domain/auth/session"
import * as entitlement from "../server/domain/billing/entitlement"
import * as engine from "../server/domain/sync/engine"

const globals = globalThis as Record<string, unknown>
globals.defineEventHandler ??= (handler: unknown) => handler

let requestBody: unknown = {}
const previousReadBody = globals.readBody
const previousSetResponseStatus = globals.setResponseStatus
globals.readBody = async () => requestBody
globals.setResponseStatus = (event: {statusCode?: number}, status: number) => {
    event.statusCode = status
}

const {default: createTask} = await import("../server/api/tasks/index.post")

type Doc = Record<string, unknown>

function same(left: unknown, right: unknown): boolean {
    if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right)
    return left === right
}

function matches(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, value]) => {
        if (value && typeof value === "object" && !(value instanceof ObjectId) && "$in" in (value as Doc)) {
            return ((value as Doc).$in as unknown[]).some((option) => same(doc[key], option))
        }
        return same(doc[key], value)
    })
}

function fakeCollection() {
    const store: Doc[] = []
    return {
        store,
        find: (filter: Doc = {}) => ({
            async toArray() {
                return store.filter((doc) => matches(doc, filter))
            }
        }),
        findOne: async (filter: Doc = {}) => store.find((doc) => matches(doc, filter)) ?? null,
        insertOne: async (doc: Doc) => {
            doc._id ??= new ObjectId()
            store.push(doc)
            return {insertedId: doc._id as ObjectId}
        },
        deleteOne: async (filter: Doc) => {
            const index = store.findIndex((doc) => matches(doc, filter))
            if (index < 0) return {deletedCount: 0}
            store.splice(index, 1)
            return {deletedCount: 1}
        }
    }
}

const db = {providerAccounts: fakeCollection(), syncTasks: fakeCollection(), users: fakeCollection()}
const userId = new ObjectId()
const sourceAccountId = new ObjectId()
const destinationAccountId = new ObjectId()
const user = {_id: userId, email: "tester@example.com", tier: "pro", displayName: "Tester", createdAt: new Date(), updatedAt: new Date()} as UserDocument

const previousCreateError = globals.createError
let collectionsSpy: ReturnType<typeof spyOn>
let userSpy: ReturnType<typeof spyOn>
let entitlementSpy: ReturnType<typeof spyOn>
let runSpy: ReturnType<typeof spyOn>

afterAll(() => {
    globals.readBody = previousReadBody
    globals.setResponseStatus = previousSetResponseStatus
    globals.createError = previousCreateError
})

function playlistRequest(direction: "one-way" | "two-way", sourcePlaylistId: string, destinationPlaylistId: string) {
    return {
        mode: "playlist" as const,
        direction,
        source: {accountId: sourceAccountId.toHexString(), playlistId: sourcePlaylistId, name: "Source"},
        destination: {accountId: destinationAccountId.toHexString(), playlistId: destinationPlaylistId, name: "Destination", createNew: false}
    }
}

async function post(body: unknown) {
    requestBody = body
    const event = {statusCode: 200, waitUntil: () => undefined}
    const result = await createTask(event as never)
    return {event, result}
}

beforeEach(() => {
    globals.createError = (input: {statusCode?: number; statusMessage?: string}) => Object.assign(new Error(input.statusMessage || "Error"), input)
    collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as unknown as Awaited<ReturnType<typeof collectionsModule.collections>>)
    userSpy = spyOn(session, "requireUser").mockResolvedValue(user)
    entitlementSpy = spyOn(entitlement, "resolveEntitlement").mockReturnValue({tier: "pro", developmentOverride: false, trialAccess: false})
    runSpy = spyOn(engine, "runSyncTask").mockResolvedValue({additions: 0, removals: 0, skipped: 0, conflicts: 0})
    db.providerAccounts.store.length = 0
    db.syncTasks.store.length = 0
    db.users.store.length = 0
    db.providerAccounts.store.push({_id: sourceAccountId, userId, provider: "spotify"}, {_id: destinationAccountId, userId, provider: "tidal"})
    db.users.store.push({_id: userId})
    db.syncTasks.insertOne = async (doc: Doc) => {
        doc._id ??= new ObjectId()
        db.syncTasks.store.push(doc)
        return {insertedId: doc._id as ObjectId}
    }
})

afterEach(() => {
    collectionsSpy.mockRestore()
    userSpy.mockRestore()
    entitlementSpy.mockRestore()
    runSpy.mockRestore()
    globals.createError = previousCreateError
})

describe("playlist task creation conflicts", () => {
    test("rejects a one-way task whose destination another task already writes", async () => {
        db.syncTasks.store.push({
            userId,
            mode: "playlist",
            direction: "one-way",
            source: {providerAccountId: sourceAccountId, playlistId: "other", name: "Other"},
            destination: {providerAccountId: destinationAccountId, playlistId: "dst", name: "Destination"}
        } as unknown as Doc)

        await expect(post(playlistRequest("one-way", "src", "dst"))).rejects.toThrow("Another sync task already writes to this playlist")
    })

    test("rejects a two-way task whose source another task already writes", async () => {
        db.syncTasks.store.push({
            userId,
            mode: "playlist",
            direction: "two-way",
            source: {providerAccountId: sourceAccountId, playlistId: "src", name: "Source"},
            destination: {providerAccountId: destinationAccountId, playlistId: "other", name: "Other"}
        } as unknown as Doc)

        await expect(post(playlistRequest("two-way", "src", "dst"))).rejects.toThrow("Another sync task already writes to this playlist")
    })

    test("rejects a destination that a full sync already maps", async () => {
        const youtubeAccountId = new ObjectId()
        db.providerAccounts.store.push({_id: youtubeAccountId, userId, provider: "youtube"})
        db.syncTasks.store.push({
            userId,
            mode: "account",
            direction: "one-way",
            source: {providerAccountId: youtubeAccountId, playlistId: "__all__", name: "All"},
            destination: {providerAccountId: destinationAccountId, playlistId: "__all__", name: "All"},
            playlistMappings: [{sourcePlaylistId: "src", destinationPlaylistId: "dst", name: "Mix"}]
        } as unknown as Doc)

        await expect(post(playlistRequest("one-way", "fresh", "dst"))).rejects.toThrow("Another sync task already writes to this playlist")
    })

    test("creates a non-conflicting playlist task", async () => {
        db.syncTasks.store.push({
            userId,
            mode: "playlist",
            direction: "one-way",
            source: {providerAccountId: sourceAccountId, playlistId: "other-src", name: "Other"},
            destination: {providerAccountId: destinationAccountId, playlistId: "other-dst", name: "Other"}
        } as unknown as Doc)

        const {event, result} = await post(playlistRequest("one-way", "src", "dst"))
        const created = db.syncTasks.store.at(-1) as unknown as SyncTaskDocument

        expect(event.statusCode).toBe(201)
        expect(result.id).toBe(created._id?.toHexString())
        expect(created.playlistWriteKeys).toEqual([`${destinationAccountId.toHexString()}:dst`])
    })

    test("rejects a concurrent insert that loses the playlist claim", async () => {
        db.syncTasks.insertOne = async () => {
            throw Object.assign(new Error("E11000 duplicate key error index: playlistWriteKeys_1"), {code: 11000, keyPattern: {playlistWriteKeys: 1}})
        }

        await expect(post(playlistRequest("one-way", "src", "dst"))).rejects.toThrow("Another sync task already writes to this playlist")
        expect(db.syncTasks.store).toHaveLength(0)
    })

    test("removes the task and rejects while the owner's deletion is pending", async () => {
        db.users.store[0]!.deletionStartedAt = new Date()

        await expect(post(playlistRequest("one-way", "src", "dst"))).rejects.toThrow("This account is being deleted")
        expect(db.syncTasks.store).toHaveLength(0)
    })

    test("creates the task when the owner's deletion flag is stale", async () => {
        db.users.store[0]!.deletionStartedAt = new Date(Date.now() - 11 * 60_000)

        const {event} = await post(playlistRequest("one-way", "src", "dst"))

        expect(event.statusCode).toBe(201)
        expect(db.syncTasks.store).toHaveLength(1)
    })
})
