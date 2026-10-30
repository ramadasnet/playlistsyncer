import {afterAll, describe, expect, spyOn, test} from "bun:test"
import {createError} from "h3"
import {ObjectId} from "mongodb"
import type {SyncRunDocument, UserDocument} from "../shared/types/domain"
import {collections, ensureIndexes} from "../server/data/collections"
import * as session from "../server/domain/auth/session"
import {closeDatabase} from "../server/utils/database"

const globals = globalThis as Record<string, unknown>
globals.createError ??= createError
globals.defineEventHandler ??= (handler: unknown) => handler

const mongoUri = process.env.PLS_MONGODB_URI

describe.skipIf(!mongoUri)("task list against MongoDB", () => {
    const now = new Date("2001-01-01T00:00:00.000Z")
    const user: UserDocument = {_id: new ObjectId(), displayName: "Task list test", tier: "free", createdAt: now, updatedAt: now}
    const taskIds: ObjectId[] = []

    afterAll(async () => {
        const db = await collections()
        await Promise.all([db.syncRuns.deleteMany({taskId: {$in: taskIds}}), db.syncTasks.deleteMany({_id: {$in: taskIds}})])
        await closeDatabase()
    })

    async function createTask(createdAt: Date): Promise<ObjectId> {
        const db = await collections()
        const accountId = new ObjectId()
        const {insertedId} = await db.syncTasks.insertOne({
            userId: user._id!,
            mode: "playlist",
            direction: "one-way",
            source: {providerAccountId: accountId, playlistId: "source", name: "Source"},
            destination: {providerAccountId: accountId, playlistId: "destination", name: "Destination"},
            status: "active",
            nextRunAt: now,
            createdAt,
            updatedAt: createdAt
        })
        taskIds.push(insertedId)
        return insertedId
    }

    function run(taskId: ObjectId, startedAt: Date, additions: number): SyncRunDocument {
        const track = {playlistId: "source", providerTrackId: "track", title: "Song", artists: ["Artist"]}
        return {taskId, trigger: "scheduled", status: "succeeded", additions, removals: 0, conflicts: 0, skipped: 0, addedTracks: [track], removedTracks: [], unmatchedTracks: [], progress: {tracksTotal: additions}, startedAt, finishedAt: startedAt}
    }

    test("returns only the newest run summary for each task", async () => {
        await ensureIndexes()
        const db = await collections()
        const withRuns = await createTask(new Date("2001-01-02T00:00:00.000Z"))
        const withoutRuns = await createTask(new Date("2001-01-01T00:00:00.000Z"))
        // Inserted out of order so the result cannot depend on insertion order.
        await db.syncRuns.insertMany([run(withRuns, new Date("2001-01-03T00:00:00.000Z"), 3), run(withRuns, new Date("2001-01-05T00:00:00.000Z"), 5), run(withRuns, new Date("2001-01-04T00:00:00.000Z"), 4)])

        const requireUser = spyOn(session, "requireUser").mockResolvedValue(user as Awaited<ReturnType<typeof session.requireUser>>)
        try {
            const {default: listTasks} = await import("../server/api/tasks/index.get")
            const {tasks} = await (listTasks as (event: unknown) => Promise<{tasks: {id?: string; latestRun?: Record<string, unknown>}[]}>)({})

            expect(tasks.map((task) => task.id)).toEqual([withRuns.toHexString(), withoutRuns.toHexString()])
            const [newest, empty] = tasks
            expect(newest!.latestRun).toMatchObject({taskId: withRuns, status: "succeeded", additions: 5, progress: {tracksTotal: 5}, startedAt: new Date("2001-01-05T00:00:00.000Z")})
            expect(newest!.latestRun).not.toHaveProperty("addedTracks")
            expect(empty!.latestRun).toBeUndefined()
        } finally {
            requireUser.mockRestore()
        }
    })
})
