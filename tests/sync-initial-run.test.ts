import {describe, expect, mock, test} from "bun:test"
import {ObjectId, type Collection} from "mongodb"
import type {ProviderAccountDocument, SyncTaskDocument, UserDocument} from "../shared/types/domain"
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
            store.push(doc)
            return {acknowledged: true, insertedId: new ObjectId()}
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
            const doc = store.find((item) => matches(item, filter))
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
            return {
                sort: (sort: Record<string, 1 | -1>) => ({
                    limit: (count: number) => ({
                        next: async () => sortDocs(matching(), sort).slice(0, count)[0] ?? null
                    })
                })
            }
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

const {runSyncTask} = await import("../server/domain/sync/engine")

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
