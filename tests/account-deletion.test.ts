import {afterAll, beforeEach, describe, expect, test} from "bun:test"
import {createError} from "h3"
import {ObjectId} from "mongodb"
import type {Provider, SyncTaskDocument, UserDocument} from "../shared/types/domain"
import {collections, ensureIndexes} from "../server/data/collections"
import {deleteUserAccount, disconnectProviderAccount} from "../server/domain/accounts"
import {closeDatabase} from "../server/utils/database"

const mongoUri = process.env.PLS_MONGODB_URI
// The sync busy check relies on the Nitro auto-imported createError.
const globals = globalThis as {createError?: unknown}
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
    })

    afterAll(async () => {
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
})
