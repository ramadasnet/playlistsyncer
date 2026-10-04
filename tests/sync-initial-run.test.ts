import {describe, expect, mock, test as bunTest} from "bun:test"

// These cases share one task, adapter, and database, so they cannot overlap.
let exclusive = Promise.resolve()
const test: typeof bunTest = ((name, fn) => {
    return bunTest(name, async () => {
        const turn = exclusive
        let release = () => undefined
        exclusive = new Promise((resolve) => {
            release = resolve
        })
        await turn
        try {
            await fn()
        } finally {
            release()
        }
    })
}) as typeof bunTest
import {ObjectId, type Collection} from "mongodb"
import type {ProviderAccountDocument, SyncRunDocument, SyncTaskDocument, UserDocument} from "../shared/types/domain"
import {reverseSyncRequestFor} from "../shared/reverse-sync"
import type {ProviderAdapter, ProviderTrack} from "../server/domain/providers/types"
import * as domain from "../shared/types/domain"
import * as cadence from "../shared/sync-cadence"

function track(itemId: string, title: string): ProviderTrack {
    return {itemId, trackId: `spotify:track:${itemId}`, title, artists: ["Artist"], durationMs: 180000}
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (left instanceof ObjectId && right instanceof ObjectId) {
        return left.equals(right)
    }
    return left === right
}

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter || {}).every(([key, value]) => {
        if (key === "$or" && Array.isArray(value)) {
            return value.some((condition) => matchesFilter(doc, condition as Record<string, unknown>))
        }
        const actual = doc[key]
        if (value instanceof ObjectId) {
            return valuesEqual(actual, value)
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            return Object.entries(value as Record<string, unknown>).every(([operator, operand]) => {
                if (operator === "$in" && Array.isArray(operand)) {
                    return operand.some((option) => valuesEqual(actual, option))
                }
                if (operator === "$nin" && Array.isArray(operand)) {
                    return !operand.some((option) => valuesEqual(actual, option))
                }
                if (operator === "$ne") {
                    return !valuesEqual(actual, operand)
                }
                if (operator === "$exists") {
                    return operand ? actual !== undefined : actual === undefined
                }
                if (actual === undefined) {
                    return true
                }
                if (operator === "$lt") {
                    return (actual as number) < (operand as number)
                }
                if (operator === "$lte") {
                    return (actual as number) <= (operand as number)
                }
                if (operator === "$gt") {
                    return (actual as number) > (operand as number)
                }
                if (operator === "$gte") {
                    return (actual as number) >= (operand as number)
                }
                return false
            })
        }
        return actual === value
    })
}

function fakeCollection<T>(docs: T[] = []): Collection<T> {
    const store = [...docs]
    const matches = (doc: T, filter: Record<string, unknown>) => matchesFilter(doc as Record<string, unknown>, filter)
    const applyUpdate = (doc: T, update: Record<string, Record<string, unknown>>) => {
        for (const [key, value] of Object.entries(update.$set || {})) {
            ;(doc as Record<string, unknown>)[key] = value
        }
        for (const [key, value] of Object.entries(update.$push || {})) {
            const current = (doc as Record<string, unknown>)[key]
            const items = value && typeof value === "object" && "$each" in value ? (value.$each as unknown[]) : [value]
            ;(doc as Record<string, unknown>)[key] = [...(Array.isArray(current) ? current : []), ...items]
        }
        for (const key of Object.keys(update.$unset || {})) {
            delete (doc as Record<string, unknown>)[key]
        }
    }
    return {
        findOne: async (filter: Record<string, unknown>) => store.find((doc) => matches(doc, filter)),
        findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
            const doc = store.find((item) => matches(item, filter))
            if (!doc) {
                return null
            }
            applyUpdate(doc, update)
            return doc
        },
        insertOne: async (doc: T) => {
            const insertedId = (doc as {_id?: ObjectId})._id || new ObjectId()
            ;(doc as {_id?: ObjectId})._id = insertedId
            store.push(doc)
            return {acknowledged: true, insertedId}
        },
        deleteOne: async (filter: Record<string, unknown>) => {
            const index = store.findIndex((doc) => matches(doc, filter))
            if (index >= 0) store.splice(index, 1)
            return {acknowledged: true, deletedCount: index >= 0 ? 1 : 0}
        },
        deleteMany: async (filter: Record<string, unknown>) => {
            const before = store.length
            for (let index = store.length - 1; index >= 0; index -= 1) {
                if (matches(store[index]!, filter)) store.splice(index, 1)
            }
            return {acknowledged: true, deletedCount: before - store.length}
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>, options?: {upsert?: boolean}) => {
            let doc = store.find((item) => matches(item, filter))
            if (!doc && options?.upsert) {
                doc = {...filter} as T
                store.push(doc)
            }
            if (doc) {
                applyUpdate(doc, update)
            }
            return {acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0}
        },
        updateMany: async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
            const matched = store.filter((item) => matches(item, filter))
            for (const doc of matched) {
                applyUpdate(doc, update)
            }
            return {acknowledged: true, matchedCount: matched.length, modifiedCount: matched.length}
        },
        find: (filter: Record<string, unknown>) => {
            const matching = () => store.filter((item) => matches(item, filter))
            const sortDocs = (docs: T[], sort: Record<string, 1 | -1>) => {
                const [key] = Object.keys(sort)
                return [...docs].sort((left, right) => {
                    const leftValue = (left as Record<string, unknown>)[key!] as number
                    const rightValue = (right as Record<string, unknown>)[key!] as number
                    return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * (sort[key!] as number)
                })
            }
            const cursor = {
                sortKey: undefined as Record<string, 1 | -1> | undefined,
                max: Number.POSITIVE_INFINITY,
                sort(sort: Record<string, 1 | -1>) {
                    this.sortKey = sort
                    return this
                },
                limit(count: number) {
                    this.max = count
                    return this
                },
                async toArray() {
                    const docs = cursor.sortKey ? sortDocs(matching(), cursor.sortKey) : matching()
                    return docs.slice(0, cursor.max)
                },
                async next() {
                    return (await this.toArray())[0] ?? null
                }
            }
            return cursor
        }
    } as unknown as Collection<T>
}

const userId = new ObjectId()
const sourceAccountId = new ObjectId()
const destAccountId = new ObjectId()
const taskId = new ObjectId()

const sourceAccount = {_id: sourceAccountId, userId, provider: "spotify"} as ProviderAccountDocument
const destAccount = {_id: destAccountId, userId, provider: "spotify"} as ProviderAccountDocument
const task = {
    _id: taskId,
    userId,
    mode: "playlist",
    status: "active",
    source: {providerAccountId: sourceAccountId, playlistId: "source-playlist", name: "Source"},
    destination: {providerAccountId: destAccountId, playlistId: "dest-playlist", name: "Destination"},
    nextRunAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
} as SyncTaskDocument

const playlists: Record<string, ProviderTrack[]> = {
    "source-playlist": [track("A:0", "Song A"), track("B:1", "Song B")],
    "dest-playlist": [track("B:0", "Song B"), track("C:1", "Song C")]
}

const addedCalls: {playlistId: string; trackIds: string[]}[] = []
const removedCalls: {playlistId: string; itemIds: string[]}[] = []

const adapter: ProviderAdapter = {
    provider: "spotify",
    listPlaylists: async () => [],
    getPlaylistItems: async (_account, playlistId) => [...(playlists[playlistId] || [])],
    searchTrack: async (_account, reference) => ({...reference}),
    searchTrackCandidates: async (_account, reference) => [reference],
    getTrackDurations: async () => new Map(),
    createPlaylist: async (_account, name) => ({id: "new-playlist", name, description: "", itemCount: 0}),
    deletePlaylist: async () => undefined,
    addTracks: async (_account, playlistId, trackIds, onAdded) => {
        addedCalls.push({playlistId, trackIds})
        await onAdded?.(trackIds.map((providerTrackId) => ({providerTrackId})))
    },
    removePlaylistItems: async (_account, playlistId, itemIds, onRemoved) => {
        removedCalls.push({playlistId, itemIds})
        await onRemoved?.(itemIds)
    }
}

const db = {
    users: fakeCollection<UserDocument>([{_id: userId, tier: "free"} as UserDocument]),
    providerAccounts: fakeCollection<ProviderAccountDocument>([sourceAccount, destAccount]),
    syncTasks: fakeCollection<SyncTaskDocument>([task]),
    syncSnapshots: fakeCollection([]),
    syncRuns: fakeCollection([])
}

mock.module("~~/shared/types/domain", () => domain)
mock.module("~~/shared/sync-cadence", () => cadence)
mock.module("../server/data/collections", () => ({collections: async () => db, ensureIndexes: async () => undefined}))
mock.module("../server/domain/providers", () => ({getProviderAdapter: () => adapter}))

const testGlobals = globalThis as {createError?: (input: {statusCode?: number; statusMessage?: string; data?: unknown}) => Error}
if (!testGlobals.createError) {
    testGlobals.createError = (input) => Object.assign(new Error(input.statusMessage || "Error"), input)
}

const {runReverseSync, runSyncTask} = await import("../server/domain/sync/engine")

describe("initial two-way playlist sync", () => {
    test("fills only the missing tracks instead of duplicating both playlists", async () => {
        const result = await runSyncTask(taskId, "manual")

        expect(result.additions).toBe(2)
        expect(result.removals).toBe(0)
        expect(removedCalls).toEqual([])
        expect(addedCalls).toEqual([
            {playlistId: "dest-playlist", trackIds: ["spotify:track:A:0"]},
            {playlistId: "source-playlist", trackIds: ["spotify:track:C:1"]}
        ])
    })
})

describe("whole-account playlist mappings", () => {
    test("retains the destination and mapping when a source disappears, even if another source has the same name", async () => {
        const accountTaskId = new ObjectId()
        const orphanMapping = {sourcePlaylistId: "old-source", destinationPlaylistId: "orphan", name: "Road trip"}
        const accountTask: SyncTaskDocument = {
            _id: accountTaskId,
            userId,
            mode: "account",
            direction: "one-way",
            source: {providerAccountId: sourceAccountId, playlistId: "__all__", name: "All playlists"},
            destination: {providerAccountId: destAccountId, playlistId: "__all__", name: "All playlists"},
            playlistMappings: [orphanMapping],
            status: "active",
            nextRunAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date()
        }
        const user = (await db.users.findOne({_id: userId}))!
        const originalTier = user.tier
        const originalListPlaylists = adapter.listPlaylists
        const originalCreatePlaylist = adapter.createPlaylist
        const originalDeletePlaylist = adapter.deletePlaylist
        const originalGetPlaylistItems = adapter.getPlaylistItems
        const destinations = [{id: "orphan", name: "Road trip", itemCount: 1}]
        let sources: typeof destinations = []
        const deleted: string[] = []
        const readItems: string[] = []
        let created = 0
        let fullSyncLeaseMs = 0

        user.tier = "pro"
        adapter.listPlaylists = async (account) => (account._id?.equals(sourceAccountId) ? [...sources] : [...destinations])
        adapter.createPlaylist = async (_account, name) => {
            const destination = {id: `created-${++created}`, name, itemCount: 0}
            destinations.push(destination)
            return destination
        }
        adapter.deletePlaylist = async (_account, playlistId) => {
            deleted.push(playlistId)
        }
        adapter.getPlaylistItems = async (account, playlistId) => {
            readItems.push(playlistId)
            if (sources.length >= 2) {
                const stored = await db.syncTasks.findOne({_id: accountTaskId})
                const remaining = stored?.leaseExpiresAt ? stored.leaseExpiresAt.getTime() - Date.now() : 0
                fullSyncLeaseMs = Math.max(fullSyncLeaseMs, remaining)
            }
            return originalGetPlaylistItems(account, playlistId)
        }
        await db.syncTasks.insertOne(accountTask)

        try {
            const firstRun = await runSyncTask(accountTaskId, "manual")
            expect(firstRun.removals).toBe(0)
            expect(deleted).toEqual([])
            expect(readItems).not.toContain("orphan")
            expect(accountTask.playlistMappings).toEqual([orphanMapping])

            sources = [{id: "new-source", name: "Road trip", itemCount: 0}]
            await runSyncTask(accountTaskId, "manual")
            expect(created).toBe(1)
            expect(deleted).toEqual([])
            expect(readItems).not.toContain("orphan")
            expect(accountTask.playlistMappings).toEqual([orphanMapping, {sourcePlaylistId: "new-source", destinationPlaylistId: "created-1", name: "Road trip"}])

            sources = [{id: "old-source", name: "Road trip", itemCount: 0}, ...sources]
            await runSyncTask(accountTaskId, "manual")
            expect(fullSyncLeaseMs).toBeGreaterThan(19 * 60 * 1000)
            expect(fullSyncLeaseMs).toBeLessThan(21 * 60 * 1000)
            expect(created).toBe(1)
            expect(readItems).toContain("orphan")
            expect(accountTask.playlistMappings?.[0]).toEqual(orphanMapping)
            const snapshots = await db.syncSnapshots.find({taskId: accountTaskId}).toArray()
            expect(snapshots).toHaveLength(1)
            expect(snapshots[0]?.batch).toBe(0)
            expect(snapshots[0]?.playlists?.map((playlist) => playlist.sourcePlaylistId)).toEqual(["old-source", "new-source"])
        } finally {
            user.tier = originalTier
            adapter.listPlaylists = originalListPlaylists
            adapter.createPlaylist = originalCreatePlaylist
            adapter.deletePlaylist = originalDeletePlaylist
            adapter.getPlaylistItems = originalGetPlaylistItems
            await db.syncTasks.deleteOne({_id: accountTaskId})
        }
    })
})

describe("deleted source restore", () => {
    const deletedSourceRestore = reverseSyncRequestFor("deleted-source")

    function missingPlaylist(provider: string) {
        const statusMessage = `${provider} API request failed (404)`
        return Object.assign(new Error(statusMessage), {statusCode: 502, statusMessage})
    }

    async function storedRuns() {
        return db.syncRuns.find({taskId}).toArray() as Promise<SyncRunDocument[]>
    }

    test("marks a missing source, then restores it once from the target", async () => {
        const originalGetPlaylistItems = adapter.getPlaylistItems
        const originalCreatePlaylist = adapter.createPlaylist
        const originalSource = playlists["source-playlist"]
        const originalDestination = playlists["dest-playlist"]
        const originalDirection = task.direction
        const originalPlaylist = {...task.source}
        const created: string[] = []
        task.direction = "one-way"
        task.source = {...task.source, name: "Road songs"}
        delete playlists["source-playlist"]
        playlists["dest-playlist"] = [track("B:0", "Song B"), track("C:1", "Song C")]
        adapter.getPlaylistItems = async (account, playlistId) => {
            if (!(playlistId in playlists)) throw missingPlaylist(account.provider)
            return originalGetPlaylistItems(account, playlistId)
        }
        adapter.createPlaylist = async (account, name) => {
            created.push(name)
            playlists["restored-source"] = []
            return originalCreatePlaylist(account, name).then((playlist) => ({...playlist, id: "restored-source", name}))
        }
        const addedBefore = addedCalls.length

        try {
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            const failed = (await storedRuns()).find((run) => run.failureReason === "deleted-source")
            expect(failed?.status).toBe("failed")
            expect(failed?.error).toBe("spotify API request failed (404)")

            const result = await runReverseSync(taskId, deletedSourceRestore)
            expect(result.additions).toBe(2)
            expect(result.removals).toBe(0)
            expect(created).toEqual(["Road songs"])
            expect(addedCalls.slice(addedBefore).map((call) => call.playlistId)).toEqual(["restored-source"])
            expect(task.direction).toBe("one-way")
            expect(task.source.playlistId).toBe("restored-source")
            expect(task.lastError).toBeUndefined()
            const restored = (await storedRuns()).find((run) => run.reverseSync?.reason === "deleted-source")
            expect(restored?.status).toBe("succeeded")
            expect(restored?.reverseSync).toEqual(deletedSourceRestore)

            await runSyncTask(taskId, "scheduled")
            expect(created).toEqual(["Road songs"])
            expect(task.direction).toBe("one-way")
        } finally {
            adapter.getPlaylistItems = originalGetPlaylistItems
            adapter.createPlaylist = originalCreatePlaylist
            task.direction = originalDirection
            task.source = originalPlaylist
            playlists["source-playlist"] = originalSource
            playlists["dest-playlist"] = originalDestination
            delete playlists["restored-source"]
        }
    })

    test("does not restore an unrelated failure, a missing target, or a source that still exists", async () => {
        const originalGetPlaylistItems = adapter.getPlaylistItems
        const originalCreatePlaylist = adapter.createPlaylist
        const originalSource = playlists["source-playlist"]
        const originalDestination = playlists["dest-playlist"]
        const created: string[] = []
        adapter.createPlaylist = async (account, name) => {
            created.push(name)
            return originalCreatePlaylist(account, name)
        }
        adapter.getPlaylistItems = async (account, playlistId) => {
            if (!(playlistId in playlists)) throw missingPlaylist(account.provider)
            return originalGetPlaylistItems(account, playlistId)
        }

        try {
            delete playlists["source-playlist"]
            delete playlists["dest-playlist"]
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            expect((await storedRuns()).at(-1)?.failureReason).toBeUndefined()

            playlists["source-playlist"] = [track("A:0", "Song A")]
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            expect((await storedRuns()).at(-1)?.failureReason).toBeUndefined()

            adapter.getPlaylistItems = async () => {
                throw new Error("spotify API request failed (500)")
            }
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (500)")
            expect((await storedRuns()).at(-1)?.failureReason).toBeUndefined()

            adapter.getPlaylistItems = async (account, playlistId) => {
                if (!(playlistId in playlists)) throw missingPlaylist(account.provider)
                return originalGetPlaylistItems(account, playlistId)
            }
            delete playlists["source-playlist"]
            playlists["dest-playlist"] = [track("B:0", "Song B")]
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            expect((await storedRuns()).at(-1)?.failureReason).toBe("deleted-source")
            playlists["source-playlist"] = [track("A:0", "Song A")]
            await expect(runReverseSync(taskId, deletedSourceRestore)).rejects.toThrow("The playlist to restore is already there")
            expect(created).toEqual([])

            await expect(runReverseSync(taskId, {...deletedSourceRestore, cadence: "ongoing"})).rejects.toThrow("This reverse sync is not available")
            await expect(runReverseSync(taskId, {...deletedSourceRestore, direction: "forward"})).rejects.toThrow("This reverse sync is not available")
        } finally {
            adapter.getPlaylistItems = originalGetPlaylistItems
            adapter.createPlaylist = originalCreatePlaylist
            if (originalSource) playlists["source-playlist"] = originalSource
            if (originalDestination) playlists["dest-playlist"] = originalDestination
        }
    })

    test("discards a created playlist when the copy fails, so the restore can be retried", async () => {
        const originalGetPlaylistItems = adapter.getPlaylistItems
        const originalCreatePlaylist = adapter.createPlaylist
        const originalAddTracks = adapter.addTracks
        const originalDeletePlaylist = adapter.deletePlaylist
        const originalSource = playlists["source-playlist"]
        const originalDestination = playlists["dest-playlist"]
        const originalPlaylist = {...task.source}
        const deleted: string[] = []
        task.source = {...task.source, name: "Road songs"}
        delete playlists["source-playlist"]
        playlists["dest-playlist"] = [track("B:0", "Song B")]
        adapter.getPlaylistItems = async (account, playlistId) => {
            if (!(playlistId in playlists)) throw missingPlaylist(account.provider)
            return originalGetPlaylistItems(account, playlistId)
        }
        adapter.createPlaylist = async (account, name) => {
            playlists["restored-source"] = []
            return originalCreatePlaylist(account, name).then((playlist) => ({...playlist, id: "restored-source", name}))
        }
        adapter.deletePlaylist = async (_account, playlistId) => {
            deleted.push(playlistId)
            delete playlists[playlistId]
        }
        adapter.addTracks = async () => {
            throw new Error("spotify API request failed (500)")
        }

        try {
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            await expect(runReverseSync(taskId, deletedSourceRestore)).rejects.toThrow("spotify API request failed (500)")
            expect(deleted).toEqual(["restored-source"])
            expect(task.source.playlistId).toBe("source-playlist")
            expect((await storedRuns()).some((run) => run.failureReason === "deleted-source")).toBe(true)

            adapter.addTracks = originalAddTracks
            await runReverseSync(taskId, deletedSourceRestore)
            expect(task.source.playlistId).toBe("restored-source")
        } finally {
            adapter.getPlaylistItems = originalGetPlaylistItems
            adapter.createPlaylist = originalCreatePlaylist
            adapter.addTracks = originalAddTracks
            adapter.deletePlaylist = originalDeletePlaylist
            task.source = originalPlaylist
            if (originalSource) playlists["source-playlist"] = originalSource
            if (originalDestination) playlists["dest-playlist"] = originalDestination
            delete playlists["restored-source"]
        }
    })

    test("keeps an unmatched target track after a partial restore", async () => {
        const originalGetPlaylistItems = adapter.getPlaylistItems
        const originalCreatePlaylist = adapter.createPlaylist
        const originalSearchTrack = adapter.searchTrack
        const originalSource = playlists["source-playlist"]
        const originalDestination = playlists["dest-playlist"]
        const originalDirection = task.direction
        const originalPlaylist = {...task.source}
        const removedBefore = removedCalls.length
        task.direction = "one-way"
        task.source = {...task.source, name: "Road songs"}
        delete playlists["source-playlist"]
        playlists["dest-playlist"] = [track("B:0", "Song B"), track("C:1", "Song C")]
        adapter.getPlaylistItems = async (account, playlistId) => {
            if (!(playlistId in playlists)) throw missingPlaylist(account.provider)
            return originalGetPlaylistItems(account, playlistId)
        }
        adapter.createPlaylist = async (account, name) => {
            playlists["restored-source"] = []
            return originalCreatePlaylist(account, name).then((playlist) => ({...playlist, id: "restored-source", name}))
        }
        adapter.searchTrack = async (_account, reference) => (reference.title === "Song C" ? null : {...reference})

        try {
            await expect(runSyncTask(taskId, "manual")).rejects.toThrow("spotify API request failed (404)")
            const result = await runReverseSync(taskId, deletedSourceRestore)
            expect(result.skipped).toBe(1)
            expect(result.additions).toBe(1)
            expect(task.source.playlistId).toBe("restored-source")
            const restored = (await storedRuns()).filter((run) => run.reverseSync?.reason === "deleted-source").at(-1)
            expect(restored?.status).toBe("partial")
            expect(restored?.unmatchedTracks.map((item) => item.title)).toEqual(["Song C"])

            await runSyncTask(taskId, "scheduled")
            const removed = removedCalls.slice(removedBefore).flatMap((call) => call.itemIds)
            expect(removed).not.toContain("C:1")
        } finally {
            adapter.getPlaylistItems = originalGetPlaylistItems
            adapter.createPlaylist = originalCreatePlaylist
            adapter.searchTrack = originalSearchTrack
            task.direction = originalDirection
            task.source = originalPlaylist
            if (originalSource) playlists["source-playlist"] = originalSource
            if (originalDestination) playlists["dest-playlist"] = originalDestination
            delete playlists["restored-source"]
        }
    })
})
