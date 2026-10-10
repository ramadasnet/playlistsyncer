import {IncomingMessage, ServerResponse} from "node:http"
import {Socket} from "node:net"
import {randomBytes} from "node:crypto"
import {afterAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {createError, createEvent, getCookie} from "h3"
import {ObjectId} from "mongodb"
import type {Provider, SyncTaskDocument, UserDocument} from "../shared/types/domain"
import * as data from "../server/data/collections"
import {collections, ensureIndexes} from "../server/data/collections"
import {deleteUserAccount, disconnectProviderAccount} from "../server/domain/accounts"
import {hashOpaqueToken} from "../server/domain/auth/session"
import * as engine from "../server/domain/sync/engine"
import {getServerConfig} from "../server/utils/config"
import {closeDatabase} from "../server/utils/database"
import * as shutdown from "../server/utils/shutdown"

const globals = globalThis as Record<string, unknown>
let taskRequestBody: unknown = {}
globals.defineEventHandler = (handler: unknown) => handler
globals.readBody = async () => taskRequestBody
globals.setResponseStatus = () => undefined
globals.getCookie = getCookie

const mongoUri = process.env.PLS_MONGODB_URI
const config = getServerConfig()
const originalSessionSecret = config.sessionSecret
// The sync busy check relies on the Nitro auto-imported createError.
const originalCreateError = globals.createError
const createdUserIds: ObjectId[] = []

async function createUser(fields: Partial<UserDocument> = {}): Promise<ObjectId> {
    const db = await collections()
    const now = new Date()
    const {insertedId} = await db.users.insertOne({displayName: "Deletion test", tier: "free", createdAt: now, updatedAt: now, ...fields})
    createdUserIds.push(insertedId)
    return insertedId
}

async function connect(userId: ObjectId, provider: Provider): Promise<ObjectId> {
    const db = await collections()
    const now = new Date()
    const {insertedId} = await db.providerAccounts.insertOne({
        userId,
        provider,
        externalAccountId: `${provider}-${new ObjectId().toHexString()}`,
        emailVerified: false,
        displayName: provider,
        accessToken: {version: 2, iv: "iv", ciphertext: "ciphertext"},
        scopes: [],
        connectedAt: now,
        updatedAt: now
    })
    return insertedId
}

async function createTask(userId: ObjectId, sourceId: ObjectId, destinationId: ObjectId, fields: Partial<SyncTaskDocument> = {}): Promise<ObjectId> {
    const db = await collections()
    const now = new Date()
    const {insertedId} = await db.syncTasks.insertOne({
        userId,
        mode: "playlist",
        direction: "one-way",
        source: {providerAccountId: sourceId, playlistId: "source", name: "Source"},
        destination: {providerAccountId: destinationId, playlistId: "destination", name: "Destination"},
        status: "active",
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
        ...fields
    })
    await db.syncRuns.insertOne({taskId: insertedId, trigger: "manual", status: "succeeded", additions: 0, removals: 0, conflicts: 0, skipped: 0, addedTracks: [], removedTracks: [], unmatchedTracks: [], startedAt: now, finishedAt: now})
    await db.syncSnapshots.insertOne({taskId: insertedId, sourceItems: [], destinationItems: [], createdAt: now})
    return insertedId
}

describe.skipIf(!mongoUri)("disconnecting providers and deleting accounts against MongoDB", () => {
    beforeEach(async () => {
        await ensureIndexes()
        globals.createError = createError
        // CI has no PLS_SESSION_SECRET. Fill the cached config the same way the OAuth flow test does.
        config.sessionSecret = config.sessionSecret || "account-deletion-session"
    })

    afterAll(async () => {
        config.sessionSecret = originalSessionSecret
        globals.createError = originalCreateError
        const db = await collections()
        const tasks = await db.syncTasks.find({userId: {$in: createdUserIds}}).toArray()
        const taskIds = tasks.map((task) => task._id)
        await Promise.all([
            db.syncRuns.deleteMany({taskId: {$in: taskIds}}),
            db.syncSnapshots.deleteMany({taskId: {$in: taskIds}}),
            db.syncTasks.deleteMany({userId: {$in: createdUserIds}}),
            db.providerAccounts.deleteMany({userId: {$in: createdUserIds}}),
            db.sessions.deleteMany({userId: {$in: createdUserIds}}),
            db.users.deleteMany({_id: {$in: createdUserIds}})
        ])
        await closeDatabase()
    })

    test("disconnects an unused provider account and deletes its tokens", async () => {
        const userId = await createUser()
        await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")

        await disconnectProviderAccount(userId, youtube)

        const db = await collections()
        expect(
            await db.providerAccounts
                .find({userId})
                .map((account) => account.provider)
                .toArray()
        ).toEqual(["spotify"])
    })

    test("refuses to disconnect an account that a sync task uses", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        await createTask(userId, spotify, youtube)

        await expect(disconnectProviderAccount(userId, youtube)).rejects.toMatchObject({statusCode: 409})
        const db = await collections()
        expect(await db.providerAccounts.countDocuments({userId})).toBe(2)
    })

    test("refuses to disconnect the only account the user signs in with", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")

        await expect(disconnectProviderAccount(userId, spotify)).rejects.toMatchObject({statusCode: 409})
    })

    test("does not disconnect another user's account", async () => {
        const owner = await createUser()
        await connect(owner, "spotify")
        const youtube = await connect(owner, "youtube")
        const other = await createUser()

        await expect(disconnectProviderAccount(other, youtube)).rejects.toMatchObject({statusCode: 404})
        const db = await collections()
        expect(await db.providerAccounts.countDocuments({userId: owner})).toBe(2)
    })

    test("deletes the user with every task, run, snapshot, account, and session", async () => {
        const userId = await createUser({creemSubscriptionStatus: "canceled"})
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        const taskId = await createTask(userId, spotify, youtube)
        const otherUser = await createUser()
        const otherSpotify = await connect(otherUser, "spotify")
        const otherYoutube = await connect(otherUser, "youtube")
        const otherTaskId = await createTask(otherUser, otherSpotify, otherYoutube)
        const db = await collections()
        const now = new Date()
        await db.sessions.insertOne({userId, tokenHash: `deletion-${userId.toHexString()}`, createdAt: now, expiresAt: new Date(now.getTime() + 60_000)})

        await deleteUserAccount((await db.users.findOne({_id: userId}))!)

        expect(await db.users.countDocuments({_id: userId})).toBe(0)
        expect(await db.providerAccounts.countDocuments({userId})).toBe(0)
        expect(await db.sessions.countDocuments({userId})).toBe(0)
        expect(await db.syncTasks.countDocuments({userId})).toBe(0)
        expect(await db.syncRuns.countDocuments({taskId})).toBe(0)
        expect(await db.syncSnapshots.countDocuments({taskId})).toBe(0)
        expect(await db.users.countDocuments({_id: otherUser})).toBe(1)
        expect(await db.providerAccounts.countDocuments({userId: otherUser})).toBe(2)
        expect(await db.syncRuns.countDocuments({taskId: otherTaskId})).toBe(1)
    })

    test("refuses to delete a user whose subscription still renews", async () => {
        const userId = await createUser({tier: "pro", creemSubscriptionStatus: "active"})
        const db = await collections()

        await expect(deleteUserAccount((await db.users.findOne({_id: userId}))!)).rejects.toMatchObject({statusCode: 409})
        expect(await db.users.countDocuments({_id: userId})).toBe(1)
    })

    test("refuses to delete a user while one of their syncs is running", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        await createTask(userId, spotify, youtube, {leaseId: "running", leaseExpiresAt: new Date(Date.now() + 60_000)})
        const db = await collections()

        await expect(deleteUserAccount((await db.users.findOne({_id: userId}))!)).rejects.toMatchObject({statusCode: 409})
        expect(await db.providerAccounts.countDocuments({userId})).toBe(2)
    })

    test("two concurrent disconnects keep one sign-in account", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")

        const results = await Promise.allSettled([disconnectProviderAccount(userId, spotify), disconnectProviderAccount(userId, youtube)])

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const rejected = results.find((result) => result.status === "rejected")
        expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({statusCode: 409})
        const db = await collections()
        expect(await db.providerAccounts.countDocuments({userId})).toBe(1)
    })

    test("reserves tasks so a scheduled run cannot write history during deletion", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        const taskId = await createTask(userId, spotify, youtube)
        const realCollections = data.collections
        let claimed = false
        const collectionsSpy = spyOn(data, "collections").mockImplementation(async () => {
            const db = await realCollections()
            const deleteMany = db.syncRuns.deleteMany.bind(db.syncRuns)
            db.syncRuns.deleteMany = (async (filter, options) => {
                if (!claimed) {
                    claimed = true
                    await expect(engine.beginSyncTask(taskId, "scheduled")).rejects.toMatchObject({statusCode: 409})
                    expect(await (await realCollections()).syncRuns.countDocuments({taskId})).toBe(1)
                }
                return deleteMany(filter, options)
            }) as typeof db.syncRuns.deleteMany
            return db
        })

        try {
            const db = await realCollections()
            await deleteUserAccount((await db.users.findOne({_id: userId}))!)
            expect(claimed).toBe(true)
            expect(await db.syncRuns.countDocuments({taskId})).toBe(0)
            expect(await db.syncTasks.countDocuments({_id: taskId})).toBe(0)
            expect(await db.users.countDocuments({_id: userId})).toBe(0)
        } finally {
            collectionsSpy.mockRestore()
        }
    })

    test("releases leases already taken when reservation fails", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        const firstId = await createTask(userId, spotify, youtube, {createdAt: new Date("2026-01-01T00:00:00.000Z")})
        const secondId = await createTask(userId, spotify, youtube, {createdAt: new Date("2026-01-02T00:00:00.000Z")})
        const realCollections = data.collections
        const leased: string[] = []
        let runLookups = 0
        const collectionsSpy = spyOn(data, "collections").mockImplementation(async () => {
            const db = await realCollections()
            const updateOne = db.syncTasks.updateOne.bind(db.syncTasks)
            db.syncTasks.updateOne = (async (filter, update, options) => {
                const leaseId = (update as {$set?: {leaseId?: string}}).$set?.leaseId
                if (leaseId) leased.push(leaseId)
                return updateOne(filter, update, options)
            }) as typeof db.syncTasks.updateOne
            const find = db.syncRuns.find.bind(db.syncRuns)
            db.syncRuns.find = ((filter, options) => {
                runLookups += 1
                if (runLookups === 1) throw new Error("run lookup failed")
                return find(filter, options)
            }) as typeof db.syncRuns.find
            return db
        })

        try {
            const db = await realCollections()
            await expect(deleteUserAccount((await db.users.findOne({_id: userId}))!)).rejects.toThrow("run lookup failed")
            expect(leased.length).toBeGreaterThan(0)
            expect((await db.syncTasks.findOne({_id: firstId}))?.leaseId).toBeUndefined()
            expect((await db.syncTasks.findOne({_id: secondId}))?.leaseId).toBeUndefined()
            expect(await db.users.countDocuments({_id: userId})).toBe(1)
        } finally {
            collectionsSpy.mockRestore()
        }
    })

    test("releases the deletion reservation when a sync is still running", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        const idleId = await createTask(userId, spotify, youtube, {createdAt: new Date("2026-01-01T00:00:00.000Z")})
        const runningId = await createTask(userId, spotify, youtube, {leaseId: "running", leaseExpiresAt: new Date(Date.now() + 60_000), createdAt: new Date("2026-01-02T00:00:00.000Z")})
        const db = await collections()

        await expect(deleteUserAccount((await db.users.findOne({_id: userId}))!)).rejects.toMatchObject({statusCode: 409})

        expect((await db.syncTasks.findOne({_id: runningId}))?.leaseId).toBe("running")
        expect((await db.syncTasks.findOne({_id: idleId}))?.leaseId).toBeUndefined()
        expect(await db.syncRuns.countDocuments({taskId: {$in: [idleId, runningId]}})).toBe(2)
        expect(await db.users.countDocuments({_id: userId})).toBe(1)
    })

    test("task creation waits for a disconnect and does not point at the removed account", async () => {
        const userId = await createUser()
        const spotify = await connect(userId, "spotify")
        const youtube = await connect(userId, "youtube")
        const token = randomBytes(32).toString("base64url")
        const db = await collections()
        const now = new Date()
        await db.sessions.insertOne({userId, tokenHash: hashOpaqueToken(token), createdAt: now, expiresAt: new Date(now.getTime() + 60_000)})
        const runSync = spyOn(shutdown, "startTrackedSyncRun").mockResolvedValue({context: {runId: new ObjectId()}, finished: Promise.resolve(undefined)} as never)
        const realCollections = data.collections
        let releaseFind: () => void = () => undefined
        const findGate = new Promise<void>((resolve) => {
            releaseFind = resolve
        })
        let ownershipReads = 0
        const collectionsSpy = spyOn(data, "collections").mockImplementation(async () => {
            const current = await realCollections()
            const find = current.providerAccounts.find.bind(current.providerAccounts)
            current.providerAccounts.find = ((filter, options) => {
                const cursor = find(filter, options)
                const toArray = cursor.toArray.bind(cursor)
                cursor.toArray = async () => {
                    const rows = await toArray()
                    const ids = (filter as {_id?: {$in?: unknown}})._id?.$in
                    if (Array.isArray(ids)) {
                        ownershipReads += 1
                        if (ownershipReads === 1) {
                            await findGate
                        }
                    }
                    return rows
                }
                return cursor
            }) as typeof current.providerAccounts.find
            return current
        })
        const {default: createTaskHandler} = await import("../server/api/tasks/index.post")
        const createTask = createTaskHandler as (event: unknown) => Promise<{id: string}>
        taskRequestBody = {
            mode: "playlist",
            direction: "one-way",
            source: {accountId: spotify.toHexString(), playlistId: "source", name: "Source"},
            destination: {accountId: youtube.toHexString(), playlistId: "destination", name: "Destination"}
        }
        const request = new IncomingMessage(new Socket())
        request.headers.cookie = `ps_session=${token}`
        const event = createEvent(request, new ServerResponse(request))
        ;(event as {waitUntil?: (promise: Promise<unknown>) => void}).waitUntil = () => undefined

        try {
            const creating = createTask(event)
            const deadline = Date.now() + 2000
            while (ownershipReads < 1) {
                if (Date.now() > deadline) {
                    throw new Error("task creation did not read provider accounts")
                }
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            const disconnecting = disconnectProviderAccount(userId, youtube)
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(await (await realCollections()).syncTasks.countDocuments({userId})).toBe(0)
            expect(await (await realCollections()).providerAccounts.countDocuments({userId})).toBe(2)
            releaseFind()
            const created = await creating
            const disconnected = await Promise.allSettled([disconnecting])
            expect(created).toEqual({id: expect.any(String)})
            expect(disconnected[0]?.status).toBe("rejected")
            expect(disconnected[0]?.status === "rejected" && disconnected[0].reason).toMatchObject({statusCode: 409})
            const fresh = await realCollections()
            const task = await fresh.syncTasks.findOne({userId})
            const accountIds = new Set((await fresh.providerAccounts.find({userId}).toArray()).map((account) => account._id?.toHexString()))
            expect(accountIds.has(task?.source.providerAccountId.toHexString())).toBe(true)
            expect(accountIds.has(task?.destination.providerAccountId.toHexString())).toBe(true)
            expect(runSync).toHaveBeenCalled()
        } finally {
            releaseFind()
            collectionsSpy.mockRestore()
            runSync.mockRestore()
        }
    })
})
