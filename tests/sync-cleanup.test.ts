import {afterAll, afterEach, describe, expect, test} from "bun:test"
import {createError} from "h3"
import {ObjectId} from "mongodb"
import type {UserDocument} from "../shared/types/domain"
import {collections, ensureIndexes} from "../server/data/collections"
import type {OutboundEmail} from "../server/domain/mail/send"
import {addMonths, buildInactiveAccountEmail, inactiveAccountDeletionDate, runSyncCleanup, syncCleanupDefaults} from "../server/domain/sync-cleanup"
import {closeDatabase} from "../server/utils/database"

const globals = globalThis as Record<string, unknown>
globals.createError ??= createError

const mongoUri = process.env.PLS_MONGODB_URI
const dayMs = 24 * 60 * 60 * 1000
// A clock in the past keeps every cutoff before any real document in a shared database.
const now = new Date("2001-01-01T05:00:00.000Z")
const createdUserIds: ObjectId[] = []
const createdTaskIds: ObjectId[] = []

describe("sync cleanup dates and email", () => {
    test("moves dates by calendar months in UTC", () => {
        expect(addMonths(new Date("2026-10-13T05:00:00.000Z"), -3)).toEqual(new Date("2026-07-13T05:00:00.000Z"))
        expect(addMonths(new Date("2026-10-13T05:00:00.000Z"), -12)).toEqual(new Date("2025-10-13T05:00:00.000Z"))
    })

    test("deletes no sooner than the grace period after the warning", () => {
        const options = {deleteAfterMonths: 12, deletionGraceDays: 30}
        expect(inactiveAccountDeletionDate(addMonths(now, -12), now, options)).toEqual(new Date(now.getTime() + 30 * dayMs))
        expect(inactiveAccountDeletionDate(addMonths(now, -6), now, options)).toEqual(addMonths(now, 6))
    })

    test("warns with the deletion date and a login link", () => {
        const email = buildInactiveAccountEmail({to: "a@example.com", displayName: "<Alex>", deletionDate: new Date("2001-01-31T05:00:00.000Z"), appUrl: "https://app.example"})
        expect(email.to).toBe("a@example.com")
        expect(email.subject).toBe("Your PlaylistSyncer account will be deleted soon")
        expect(email.text).toContain("on or after January 31, 2001")
        expect(email.text).toContain("https://app.example/login")
        expect(email.html).toContain("Hi &lt;Alex&gt;,")
    })
})

describe.skipIf(!mongoUri)("sync cleanup against MongoDB", () => {
    async function createUser(fields: Partial<UserDocument>): Promise<ObjectId> {
        const db = await collections()
        const {insertedId} = await db.users.insertOne({displayName: "Cleanup test", tier: "free", createdAt: now, updatedAt: now, ...fields})
        createdUserIds.push(insertedId)
        return insertedId
    }

    async function createTask(userId: ObjectId): Promise<ObjectId> {
        const db = await collections()
        const accountId = new ObjectId()
        const {insertedId} = await db.syncTasks.insertOne({
            userId,
            mode: "playlist",
            direction: "one-way",
            source: {providerAccountId: accountId, playlistId: "source", name: "Source"},
            destination: {providerAccountId: accountId, playlistId: "destination", name: "Destination"},
            status: "paused",
            nextRunAt: addMonths(now, 1200),
            createdAt: now,
            updatedAt: now
        })
        createdTaskIds.push(insertedId)
        return insertedId
    }

    async function createRun(taskId: ObjectId, startedAt: Date): Promise<ObjectId> {
        const db = await collections()
        const {insertedId} = await db.syncRuns.insertOne({
            taskId,
            trigger: "scheduled",
            status: "succeeded",
            additions: 0,
            removals: 0,
            conflicts: 0,
            skipped: 0,
            addedTracks: [],
            removedTracks: [],
            unmatchedTracks: [],
            startedAt,
            finishedAt: startedAt
        })
        return insertedId
    }

    async function deleteCreatedFixtures() {
        if (!createdUserIds.length && !createdTaskIds.length) {
            return
        }
        const db = await collections()
        await Promise.all([
            db.syncRuns.deleteMany({taskId: {$in: createdTaskIds}}),
            db.syncTasks.deleteMany({_id: {$in: createdTaskIds}}),
            db.users.deleteMany({_id: {$in: createdUserIds}})
        ])
        createdUserIds.length = 0
        createdTaskIds.length = 0
    }

    afterEach(deleteCreatedFixtures)

    afterAll(async () => {
        await deleteCreatedFixtures()
        await closeDatabase()
    })

    test("deletes old runs and inactive users, and warns the users who are next", async () => {
        await ensureIndexes()
        const db = await collections()
        const longAgo = addMonths(now, -13)
        const recent = addMonths(now, -1)
        const graceOver = new Date(now.getTime() - 31 * dayMs)

        const activeOwner = await createUser({email: `owner-${new ObjectId()}@example.com`, lastLoginAt: longAgo})
        const taskId = await createTask(activeOwner)
        const oldRun = await createRun(taskId, addMonths(now, -4))
        const keptRun = await createRun(taskId, addMonths(now, -2))

        const warnedLongAgo = await createUser({email: `warned-${new ObjectId()}@example.com`, lastLoginAt: longAgo, inactivityWarningSentAt: graceOver})
        const warnedRecently = await createUser({email: `recent-${new ObjectId()}@example.com`, lastLoginAt: longAgo, inactivityWarningSentAt: new Date(now.getTime() - 5 * dayMs)})
        const noEmail = await createUser({lastLoginAt: longAgo})
        const toWarn = await createUser({email: `warn-${new ObjectId()}@example.com`, lastLoginAt: longAgo})
        const subscribed = await createUser({email: `pro-${new ObjectId()}@example.com`, lastLoginAt: longAgo, creemSubscriptionStatus: "active"})
        const loggedInRecently = await createUser({email: `active-${new ObjectId()}@example.com`, lastLoginAt: recent})

        const sent: OutboundEmail[] = []
        const result = await runSyncCleanup({now, appUrl: "https://app.example", send: async (message) => (sent.push(message), true)})

        expect(result.failed).toBe(0)
        expect(result.runsDeleted).toBe(1)
        expect(await db.syncRuns.countDocuments({_id: {$in: [oldRun, keptRun]}})).toBe(1)
        expect(await db.syncRuns.findOne({_id: keptRun})).not.toBeNull()

        const remaining = (await db.users.find({_id: {$in: createdUserIds}}).toArray()).map((user) => user._id.toHexString())
        expect(remaining).not.toContain(warnedLongAgo.toHexString())
        expect(remaining).not.toContain(noEmail.toHexString())
        for (const kept of [activeOwner, warnedRecently, toWarn, subscribed, loggedInRecently]) {
            expect(remaining).toContain(kept.toHexString())
        }
        expect(result.usersDeleted).toBe(2)

        expect(sent.map((message) => message.to)).toEqual([(await db.users.findOne({_id: toWarn}))!.email!])
        expect((await db.users.findOne({_id: toWarn}))?.inactivityWarningSentAt).toEqual(now)
        expect(result.usersWarned).toBe(1)

        // A second run inside the grace period neither warns again nor deletes the warned user.
        const again = await runSyncCleanup({now, send: async (message) => (sent.push(message), true)})
        expect(again).toEqual({runsDeleted: 0, usersDeleted: 0, usersWarned: 0, failed: 0})
        expect(sent).toHaveLength(1)
    })

    test("leaves users unwarned when mail is not configured", async () => {
        const userId = await createUser({email: `nomail-${new ObjectId()}@example.com`, lastLoginAt: addMonths(now, -syncCleanupDefaults.warnAfterMonths - 1)})
        const result = await runSyncCleanup({now, send: async () => false})
        const db = await collections()
        expect(result.usersWarned).toBe(0)
        expect((await db.users.findOne({_id: userId}))?.inactivityWarningSentAt).toBeUndefined()
    })
})
