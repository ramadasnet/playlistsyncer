import {afterAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import type {H3Event} from "h3"
import {ObjectId, type Collection} from "mongodb"
import type {Provider, ProviderAccountDocument, SyncRunDocument, SyncSnapshotDocument, SyncTaskDocument, UserDocument} from "../shared/types/domain"
import type {ProviderAdapter, ProviderTrack} from "../server/domain/providers/types"
import * as collectionsModule from "../server/data/collections"
import * as providers from "../server/domain/providers"
import * as schedulerAuth from "../server/utils/scheduler-auth"
import {nextQuotaResetAt} from "../server/domain/providers/http"
import {beginSyncTask, completeSyncTask, failInterruptedRuns, failureBackoffMs, runSyncTask} from "../server/domain/sync/engine"
import {linkSnapshotRow} from "../server/domain/sync/manual-match"
import {withTaskLease} from "../server/domain/sync/task-activity"
import syncDue from "../server/jobs/routes/sync-due"

// Regression tests for the production-readiness sync engine findings. They run the real engine
// against an in-memory database and in-memory provider playlists.

type Doc = Record<string, unknown>

function same(left: unknown, right: unknown): boolean {
    if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right)
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
    return left === right
}

function compare(actual: unknown, operand: unknown): number | undefined {
    if (actual === undefined || actual === null) return undefined
    const left = actual instanceof Date ? actual.getTime() : (actual as number)
    const right = operand instanceof Date ? operand.getTime() : (operand as number)
    return left < right ? -1 : left > right ? 1 : 0
}

function matches(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, value]) => {
        if (key === "$or") return (value as Doc[]).some((condition) => matches(doc, condition))
        const actual = doc[key]
        if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date) && !Array.isArray(value)) {
            return Object.entries(value as Doc).every(([operator, operand]) => {
                const order = compare(actual, operand)
                if (operator === "$in") return (operand as unknown[]).some((option) => same(actual, option))
                if (operator === "$ne") return !same(actual, operand)
                if (operator === "$exists") return operand ? actual !== undefined : actual === undefined
                if (operator === "$lt") return order !== undefined && order < 0
                if (operator === "$lte") return order !== undefined && order <= 0
                if (operator === "$gt") return order !== undefined && order > 0
                if (operator === "$gte") return order !== undefined && order >= 0
                throw new Error(`Unsupported operator ${operator}`)
            })
        }
        return same(actual, value)
    })
}

function applyUpdate(doc: Doc, update: Record<string, Doc>) {
    for (const [key, value] of Object.entries(update.$set || {})) doc[key] = value
    for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = ((doc[key] as number) || 0) + (value as number)
    for (const [key, value] of Object.entries(update.$push || {})) {
        const items = value && typeof value === "object" && "$each" in value ? ((value as Doc).$each as unknown[]) : [value]
        doc[key] = [...((doc[key] as unknown[]) || []), ...items]
    }
    for (const key of Object.keys(update.$unset || {})) delete doc[key]
}

function fakeCollection<T>() {
    const store: Doc[] = []
    const collection = {
        store,
        findOne: async (filter: Doc) => store.find((doc) => matches(doc, filter)) ?? null,
        findOneAndUpdate: async (filter: Doc, update: Record<string, Doc>) => {
            const doc = store.find((item) => matches(item, filter))
            if (doc) applyUpdate(doc, update)
            return doc ?? null
        },
        insertOne: async (doc: Doc) => {
            doc._id ??= new ObjectId()
            store.push(doc)
            return {acknowledged: true, insertedId: doc._id}
        },
        updateOne: async (filter: Doc, update: Record<string, Doc>, options?: {upsert?: boolean}) => {
            let doc = store.find((item) => matches(item, filter))
            if (!doc && options?.upsert) {
                doc = {_id: new ObjectId(), ...filter}
                store.push(doc)
            }
            if (doc) applyUpdate(doc, update)
            return {acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0}
        },
        updateMany: async (filter: Doc, update: Record<string, Doc>) => {
            const matched = store.filter((item) => matches(item, filter))
            for (const doc of matched) applyUpdate(doc, update)
            return {acknowledged: true, matchedCount: matched.length, modifiedCount: matched.length}
        },
        deleteOne: async (filter: Doc) => {
            const index = store.findIndex((doc) => matches(doc, filter))
            if (index >= 0) store.splice(index, 1)
            return {acknowledged: true, deletedCount: index >= 0 ? 1 : 0}
        },
        deleteMany: async (filter: Doc) => {
            const before = store.length
            for (let index = store.length - 1; index >= 0; index--) if (matches(store[index]!, filter)) store.splice(index, 1)
            return {acknowledged: true, deletedCount: before - store.length}
        },
        find: (filter: Doc = {}) => {
            let sortKey: [string, number] | undefined
            let max = Number.POSITIVE_INFINITY
            const cursor = {
                sort(sort: Record<string, number>) {
                    sortKey = Object.entries(sort)[0]
                    return cursor
                },
                limit(count: number) {
                    max = count
                    return cursor
                },
                async toArray() {
                    const docs = store.filter((doc) => matches(doc, filter))
                    if (sortKey) {
                        const [key, direction] = sortKey
                        docs.sort((left, right) => (compare(left[key], right[key]) || 0) * direction)
                    }
                    return docs.slice(0, max)
                },
                async next() {
                    return (await cursor.toArray())[0] ?? null
                }
            }
            return cursor
        }
    }
    return collection as typeof collection & Collection<T>
}

const db = {
    users: fakeCollection<UserDocument>(),
    providerAccounts: fakeCollection<ProviderAccountDocument>(),
    syncTasks: fakeCollection<SyncTaskDocument>(),
    syncSnapshots: fakeCollection<SyncSnapshotDocument>(),
    syncRuns: fakeCollection<SyncRunDocument>(),
    searchMisses: fakeCollection()
}

// In-memory provider catalogs and playlists, keyed by provider account and playlist id.
interface FakePlaylist {
    name: string
    tracks: ProviderTrack[]
    owned?: boolean
}

const playlists = new Map<string, FakePlaylist>()
const catalogs: Partial<Record<Provider, ProviderTrack[]>> = {}
const calls: {searches: {provider: Provider; title: string}[]; added: {playlistId: string; trackIds: string[]}[]; removed: {playlistId: string; itemIds: string[]}[]} = {searches: [], added: [], removed: []}
// Lets a test fail a provider call, for example to simulate a used-up quota.
let beforeSearch: (provider: Provider) => void = () => undefined
let beforeRead: (playlistId: string) => void = () => undefined
let itemCounter = 0

function playlistKey(account: ProviderAccountDocument, playlistId: string) {
    return `${account._id!.toHexString()}:${playlistId}`
}

function missingPlaylist(provider: string) {
    const message = `${provider} API request failed (404)`
    return Object.assign(new Error(message), {statusCode: 502, statusMessage: message})
}

function adapterFor(provider: Provider): ProviderAdapter {
    return {
        provider,
        listPlaylists: async (account) =>
            [...playlists.entries()]
                .filter(([key, playlist]) => key.startsWith(`${account._id!.toHexString()}:`) && playlist.owned !== false)
                .map(([key, playlist]) => ({id: key.split(":")[1]!, name: playlist.name, itemCount: playlist.tracks.length})),
        createPlaylist: async (account, name) => {
            const id = `created-${++itemCounter}`
            playlists.set(playlistKey(account, id), {name, tracks: []})
            return {id, name, itemCount: 0}
        },
        deletePlaylist: async (account, playlistId) => {
            playlists.delete(playlistKey(account, playlistId))
        },
        getPlaylistItems: async (account, playlistId) => {
            beforeRead(playlistId)
            const playlist = playlists.get(playlistKey(account, playlistId))
            if (!playlist) throw missingPlaylist(provider)
            return playlist.tracks.map((track) => ({...track}))
        },
        searchTrack: async (_account, reference) => {
            beforeSearch(provider)
            calls.searches.push({provider, title: reference.title})
            const catalog = catalogs[provider] || []
            return catalog.find((track) => (reference.isrc && track.isrc === reference.isrc) || track.title.toLowerCase().includes(reference.title.toLowerCase().split(" - ")[0]!)) ?? null
        },
        searchTrackCandidates: async () => [],
        getTrackDurations: async () => new Map(),
        addTracks: async (account, playlistId, trackIds, onAdded) => {
            const playlist = playlists.get(playlistKey(account, playlistId))!
            calls.added.push({playlistId, trackIds})
            const added = trackIds.map((trackId) => {
                const track = (catalogs[provider] || []).find((item) => item.trackId === trackId)!
                const itemId = `${trackId}#${++itemCounter}`
                playlist.tracks.push({...track, itemId})
                return {providerTrackId: trackId, providerItemId: itemId}
            })
            await onAdded?.(added)
        },
        removePlaylistItems: async (account, playlistId, itemIds, onRemoved) => {
            const playlist = playlists.get(playlistKey(account, playlistId))!
            calls.removed.push({playlistId, itemIds})
            playlist.tracks = playlist.tracks.filter((track) => !itemIds.includes(track.itemId))
            await onRemoved?.(itemIds)
        }
    }
}

const adapters = new Map<Provider, ProviderAdapter>()

const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as unknown as Awaited<ReturnType<typeof collectionsModule.collections>>)
const adapterSpy = spyOn(providers, "getProviderAdapter").mockImplementation((provider: Provider) => {
    if (!adapters.has(provider)) adapters.set(provider, adapterFor(provider))
    return adapters.get(provider)!
})
const schedulerSpy = spyOn(schedulerAuth, "requireScheduler").mockImplementation(() => undefined)
afterAll(() => {
    collectionsSpy.mockRestore()
    adapterSpy.mockRestore()
    schedulerSpy.mockRestore()
})

const testGlobals = globalThis as {createError?: (input: {statusCode?: number; statusMessage?: string; data?: unknown}) => Error}
testGlobals.createError ??= (input) => Object.assign(new Error(input.statusMessage || "Error"), input)

const userId = new ObjectId()
const accounts: Record<string, ProviderAccountDocument> = {}

function account(provider: Provider): ProviderAccountDocument {
    if (!accounts[provider]) {
        accounts[provider] = {_id: new ObjectId(), userId, provider, externalAccountId: provider} as ProviderAccountDocument
        db.providerAccounts.store.push(accounts[provider] as unknown as Doc)
    }
    return accounts[provider]
}

function track(provider: Provider, id: string, title: string, artist: string, isrc?: string): ProviderTrack {
    return {itemId: `${provider}:${id}`, trackId: `${provider}:${id}`, title, artists: [artist], ...(isrc ? {isrc} : {})}
}

function setPlaylist(provider: Provider, playlistId: string, name: string, tracks: ProviderTrack[], owned = true) {
    playlists.set(playlistKey(account(provider), playlistId), {name, tracks, owned})
}

function playlistTitles(provider: Provider, playlistId: string) {
    return playlists.get(playlistKey(account(provider), playlistId))?.tracks.map((item) => item.title)
}

async function insertTask(task: Partial<SyncTaskDocument> & Pick<SyncTaskDocument, "source" | "destination">): Promise<ObjectId> {
    const now = new Date()
    const {insertedId} = await db.syncTasks.insertOne({mode: "playlist", direction: "one-way", userId, status: "active", nextRunAt: now, createdAt: now, updatedAt: now, ...task} as unknown as Doc)
    return insertedId as ObjectId
}

function side(provider: Provider, playlistId: string, name = playlistId) {
    return {providerAccountId: account(provider)._id!, playlistId, name}
}

async function storedTask(taskId: ObjectId) {
    return (await db.syncTasks.findOne({_id: taskId})) as unknown as SyncTaskDocument
}

async function latestRun(taskId: ObjectId) {
    return (await db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(1).next()) as unknown as SyncRunDocument
}

beforeEach(() => {
    for (const collection of Object.values(db)) collection.store.length = 0
    for (const key of Object.keys(accounts)) delete accounts[key]
    for (const key of Object.keys(catalogs)) delete catalogs[key as Provider]
    playlists.clear()
    adapters.clear()
    calls.searches.length = 0
    calls.added.length = 0
    calls.removed.length = 0
    beforeSearch = () => undefined
    beforeRead = () => undefined
    db.users.store.push({_id: userId, tier: "pro", displayName: "Tester", createdAt: new Date(), updatedAt: new Date()})
})

describe("failed runs back off", () => {
    test("failing tasks no longer hold the head of the scheduler queue", async () => {
        const old = new Date(Date.now() - 60 * 60 * 1000)
        // Twelve tasks whose provider account was disconnected fail on every run.
        for (let index = 0; index < 12; index++) {
            await insertTask({source: {providerAccountId: new ObjectId(), playlistId: "gone", name: `Broken ${index}`}, destination: side("tidal", "dst"), nextRunAt: new Date(old.getTime() + index)})
        }
        setPlaylist("spotify", "src", "Healthy", [track("spotify", "1", "Song", "Artist", "US0000000001")])
        setPlaylist("tidal", "healthy-dst", "Healthy", [])
        catalogs.tidal = [track("tidal", "1", "Song", "Artist", "US0000000001")]
        const healthy = await insertTask({source: side("spotify", "src"), destination: side("tidal", "healthy-dst"), nextRunAt: new Date(old.getTime() + 100)})

        const first = (await syncDue({} as H3Event)) as {processed: number; results: {id: string; ok: boolean}[]}
        expect(first.processed).toBe(10)
        expect(first.results.every((result) => !result.ok)).toBe(true)
        const second = (await syncDue({} as H3Event)) as {results: {id: string; ok: boolean}[]}
        expect(second.results.find((result) => result.id === healthy.toHexString())?.ok).toBe(true)
        expect(playlistTitles("tidal", "healthy-dst")).toEqual(["Song"])

        const broken = (await db.syncTasks.find({destination: {$exists: true}}).toArray()).filter((task) => !(task._id as ObjectId).equals(healthy)) as unknown as SyncTaskDocument[]
        for (const task of broken) {
            expect(task.consecutiveFailures).toBe(1)
            expect(task.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
        }
        // A third call finds nothing due: every failing task waits for its backoff.
        expect(((await syncDue({} as H3Event)) as {processed: number}).processed).toBe(0)
    })

    test("doubles the delay for each consecutive failure up to the plan interval and resets after a success", async () => {
        const interval = 12 * 60 * 60 * 1000
        expect([1, 2, 3, 4, 5, 6].map((failures) => failureBackoffMs(failures, interval) / 3600000)).toEqual([1, 2, 4, 8, 12, 12])

        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst")})
        setPlaylist("tidal", "dst", "Destination", [])
        await expect(runSyncTask(taskId, "scheduled")).rejects.toThrow("The Spotify source playlist no longer exists")
        await expect(runSyncTask(taskId, "scheduled")).rejects.toThrow()
        const failing = await storedTask(taskId)
        expect(failing.consecutiveFailures).toBe(2)
        expect(Math.round((failing.nextRunAt.getTime() - Date.now()) / 60000)).toBe(120)

        setPlaylist("spotify", "src", "Source", [])
        await runSyncTask(taskId, "manual")
        const recovered = await storedTask(taskId)
        expect(recovered.consecutiveFailures).toBeUndefined()
        expect(recovered.lastError).toBeUndefined()
        expect(Math.round((recovered.nextRunAt.getTime() - Date.now()) / 60000)).toBe(720)
    })

    test("skips due tasks that still hold a lease", async () => {
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst"), leaseId: "other", leaseExpiresAt: new Date(Date.now() + 60000)})
        const result = (await syncDue({} as H3Event)) as {processed: number}
        expect(result.processed).toBe(0)
        expect((await storedTask(taskId)).leaseId).toBe("other")
    })
})

describe("full-account sync keeps matched tracks", () => {
    async function runAccountSync(destination: Provider) {
        const taskId = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side(destination, "__all__")})
        const results = []
        for (let run = 0; run < 3; run++) results.push(await runSyncTask(taskId, "scheduled"))
        return results
    }

    test("does not remove and re-add a track whose title differs but whose ISRC matches", async () => {
        setPlaylist("spotify", "road", "Road trip", [track("spotify", "1", "Song - Remastered 2011", "Artist", "GB0000000001")])
        catalogs.tidal = [track("tidal", "9", "Song", "Artist", "GB0000000001")]

        const [first, second, third] = await runAccountSync("tidal")

        expect(first).toMatchObject({additions: 1, removals: 0})
        expect(second).toMatchObject({additions: 0, removals: 0})
        expect(third).toMatchObject({additions: 0, removals: 0})
    })

    test("keeps a YouTube copy without an ISRC through the snapshot alias", async () => {
        setPlaylist("spotify", "road", "Road trip", [track("spotify", "1", "Song", "Artist", "GB0000000001")])
        catalogs.youtube = [track("youtube", "v1", "Song (Official Music Video)", "Artist")]

        const [first, second, third] = await runAccountSync("youtube")

        expect(first).toMatchObject({additions: 1, removals: 0})
        expect(second).toMatchObject({additions: 0, removals: 0})
        expect(third).toMatchObject({additions: 0, removals: 0})
        expect(calls.searches).toHaveLength(1)
    })
})

describe("first two-way run", () => {
    test("pairs tracks both playlists already share instead of adding them again", async () => {
        const spotifyTracks = [track("spotify", "1", "Bohemian Rhapsody - Remastered 2011", "Queen", "GBUM71029604"), track("spotify", "2", "Under Pressure", "Queen")]
        const tidalTracks = [track("tidal", "1", "Bohemian Rhapsody", "Queen", "GBUM71029604"), track("tidal", "2", "Under Pressure - 2011 Remaster", "Queen")]
        setPlaylist("spotify", "src", "Mix", [...spotifyTracks])
        setPlaylist("tidal", "dst", "Mix", [...tidalTracks])
        // Each catalog has the other side's copy, so a missed pairing would add a duplicate.
        catalogs.spotify = spotifyTracks
        catalogs.tidal = tidalTracks
        const taskId = await insertTask({direction: "two-way", source: side("spotify", "src"), destination: side("tidal", "dst")})

        const first = await runSyncTask(taskId, "created")
        const second = await runSyncTask(taskId, "scheduled")

        expect(first).toMatchObject({additions: 0, removals: 0, skipped: 0})
        expect(second).toMatchObject({additions: 0, removals: 0, skipped: 0})
        expect(calls.searches).toEqual([])
        expect(calls.added).toEqual([])
        expect(playlistTitles("spotify", "src")).toHaveLength(2)
        expect(playlistTitles("tidal", "dst")).toHaveLength(2)
    })
})

describe("interrupted copies", () => {
    test("pairs a copy of a track recorded as unmatched after the run that added it stopped", async () => {
        const source = [track("spotify", "a", "Alpha", "Artist"), track("spotify", "u", "Late", "Artist")]
        setPlaylist("spotify", "src", "Mix", [...source])
        setPlaylist("youtube", "dst", "Mix", [])
        catalogs.youtube = [track("youtube", "va", "Alpha (Official Video)", "Artist")]
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("youtube", "dst")})
        expect(await runSyncTask(taskId, "created")).toMatchObject({additions: 1, skipped: 1})

        // A week later the unmatched track is on YouTube. The run adds it, then the quota runs out before the snapshot is saved.
        db.searchMisses.store.length = 0
        catalogs.youtube.push(track("youtube", "vu", "Late (Official Video)", "Artist"), track("youtube", "vc", "Closer (Official Video)", "Artist"))
        setPlaylist("spotify", "src", "Mix", [...source, track("spotify", "c", "Closer", "Artist")])
        let quota = 1
        beforeSearch = () => {
            if (quota-- <= 0) throw Object.assign(new Error("quota"), {statusCode: 429, statusMessage: "quota", data: {quotaExceeded: true}})
        }
        await expect(runSyncTask(taskId, "scheduled")).rejects.toThrow("quota")

        quota = Number.POSITIVE_INFINITY
        calls.searches.length = 0
        calls.removed.length = 0
        const retry = await runSyncTask(taskId, "scheduled")

        expect(calls.searches.map((search) => search.title)).toEqual(["Closer"])
        expect(retry).toMatchObject({additions: 1, removals: 0})
        expect(playlistTitles("youtube", "dst")).toEqual(["Alpha (Official Video)", "Late (Official Video)", "Closer (Official Video)"])
    })
})

describe("competing writers", () => {
    test("a full sync skips an existing mapping whose playlist an older pair task writes", async () => {
        setPlaylist("spotify", "a", "Alpha", [track("spotify", "1", "One", "Artist", "US0000000001")])
        setPlaylist("spotify", "b", "Beta", [track("spotify", "2", "Two", "Artist", "US0000000002")])
        setPlaylist("tidal", "shared", "Beta", [track("tidal", "7", "Kept", "Artist")])
        catalogs.tidal = [track("tidal", "1", "One", "Artist", "US0000000001"), track("tidal", "2", "Two", "Artist", "US0000000002")]
        await insertTask({source: side("spotify", "pair-src"), destination: side("tidal", "shared"), createdAt: new Date(Date.now() - 60000)})
        const accountTask = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__"), playlistMappings: [{sourcePlaylistId: "b", destinationPlaylistId: "shared", name: "Beta"}]})

        await runSyncTask(accountTask, "scheduled")

        expect(playlistTitles("tidal", "shared")).toEqual(["Kept"])
        const run = await latestRun(accountTask)
        expect(run.status).toBe("partial")
        expect(run.failedPlaylists).toEqual([{sourcePlaylistId: "b", name: "Beta", error: "An older sync task already writes to the TIDAL destination playlist"}])
    })

    test("a pair task leaves a playlist that an older full sync maps", async () => {
        setPlaylist("spotify", "src", "Mix", [track("spotify", "1", "One", "Artist", "US0000000001")])
        setPlaylist("tidal", "shared", "Mix", [track("tidal", "7", "Kept", "Artist")])
        await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__"), playlistMappings: [{sourcePlaylistId: "x", destinationPlaylistId: "shared", name: "Mix"}], createdAt: new Date(Date.now() - 60000)})
        const pairTask = await insertTask({source: side("spotify", "src"), destination: side("tidal", "shared")})

        await expect(runSyncTask(pairTask, "manual")).rejects.toThrow("An older sync task already writes to the TIDAL destination playlist")
        expect(playlistTitles("tidal", "shared")).toEqual(["Kept"])
    })

    test("only one of two pair tasks created at the same moment writes the shared playlist", async () => {
        setPlaylist("spotify", "src", "Mix", [track("spotify", "1", "One", "Artist", "US0000000001")])
        setPlaylist("tidal", "shared", "Mix", [])
        catalogs.tidal = [track("tidal", "1", "One", "Artist", "US0000000001")]
        const createdAt = new Date()
        const first = await insertTask({source: side("spotify", "src"), destination: side("tidal", "shared"), createdAt})
        const second = await insertTask({source: side("spotify", "src"), destination: side("tidal", "shared"), createdAt})
        const [older, younger] = first.toHexString() < second.toHexString() ? [first, second] : [second, first]

        await runSyncTask(older, "manual")
        await expect(runSyncTask(younger, "manual")).rejects.toThrow("An older sync task already writes")
        expect(playlistTitles("tidal", "shared")).toEqual(["One"])
    })
})

describe("full-account sync isolates playlist failures", () => {
    test("syncs the other playlists and reports the one that failed", async () => {
        setPlaylist("spotify", "a", "Alpha", [track("spotify", "1", "One", "Artist", "US0000000001")])
        setPlaylist("spotify", "editorial", "Editorial", [track("spotify", "2", "Two", "Artist", "US0000000002")])
        setPlaylist("spotify", "c", "Gamma", [track("spotify", "3", "Three", "Artist", "US0000000003")])
        catalogs.tidal = [track("tidal", "1", "One", "Artist", "US0000000001"), track("tidal", "2", "Two", "Artist", "US0000000002"), track("tidal", "3", "Three", "Artist", "US0000000003")]
        beforeRead = (playlistId) => {
            if (playlistId === "editorial") throw missingPlaylist("spotify")
        }
        const taskId = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__"), playlistMappings: [{sourcePlaylistId: "deleted", destinationPlaylistId: "kept", name: "Old mix"}]})

        const result = await runSyncTask(taskId, "scheduled")

        expect(result.additions).toBe(2)
        const run = await latestRun(taskId)
        expect(run.status).toBe("partial")
        expect(run.failedPlaylists).toEqual([{sourcePlaylistId: "editorial", name: "Editorial", error: "spotify API request failed (404)"}])
        expect(run.missingSourcePlaylists).toEqual([{sourcePlaylistId: "deleted", destinationPlaylistId: "kept", name: "Old mix"}])
        expect((await storedTask(taskId)).lastError).toBe('1 playlist could not be synced: "Editorial"')
    })

    test("fails the run when every playlist fails", async () => {
        setPlaylist("spotify", "a", "Alpha", [])
        beforeRead = () => {
            throw new Error("spotify API request failed (500)")
        }
        const taskId = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__")})

        await expect(runSyncTask(taskId, "scheduled")).rejects.toThrow("spotify API request failed (500)")
        const run = await latestRun(taskId)
        expect(run.status).toBe("failed")
        expect(run.failedPlaylists).toEqual([{sourcePlaylistId: "a", name: "Alpha", error: "spotify API request failed (500)"}])
        expect((await storedTask(taskId)).consecutiveFailures).toBe(1)
    })

    test("counts tracks a playlist added before it failed", async () => {
        setPlaylist("spotify", "a", "Alpha", [track("spotify", "1", "One", "Artist", "US0000000001")])
        setPlaylist("spotify", "b", "Beta", [track("spotify", "2", "Two", "Artist", "US0000000002")])
        catalogs.tidal = [track("tidal", "1", "One", "Artist", "US0000000001"), track("tidal", "2", "Two", "Artist", "US0000000002")]
        let betaReads = 0
        // Beta's tracks are added, then its verification read fails.
        beforeRead = (playlistId) => {
            if (playlistId === "b" && ++betaReads === 2) throw new Error("spotify API request failed (500)")
        }
        const taskId = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__")})

        const result = await runSyncTask(taskId, "scheduled")

        expect(result.additions).toBe(2)
        const run = await latestRun(taskId)
        expect(run).toMatchObject({status: "partial", additions: 2})
        expect(run.addedTracks.map((item) => item.title)).toEqual(["One", "Two"])
        expect(run.failedPlaylists?.map((playlist) => playlist.name)).toEqual(["Beta"])
    })
})

describe("YouTube quota", () => {
    function quotaError() {
        return Object.assign(new Error("The YouTube daily API quota is used up."), {statusCode: 429, statusMessage: "The YouTube daily API quota is used up.", data: {quotaExceeded: true}})
    }

    test("keeps tracks added before the quota ran out, waits for the reset, and resumes without clearing the target", async () => {
        const titles = ["One", "Two", "Three", "Four", "Five"]
        setPlaylist("spotify", "src", "Mix", [...titles.map((title, index) => track("spotify", String(index), title, "Artist")), track("spotify", "x", "Nowhere", "Artist")])
        setPlaylist("youtube", "dst", "Mix", [track("youtube", "old", "Stale", "Artist")])
        catalogs.youtube = titles.map((title, index) => track("youtube", `v${index}`, `${title} (Official Video)`, "Artist"))
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("youtube", "dst")})
        let quota = 3
        beforeSearch = () => {
            if (quota-- <= 0) throw quotaError()
        }

        await expect(runSyncTask(taskId, "created")).rejects.toThrow("quota is used up")
        expect(playlistTitles("youtube", "dst")).toEqual(["One (Official Video)", "Two (Official Video)", "Three (Official Video)"])
        const waiting = await storedTask(taskId)
        expect(waiting.nextRunAt.getTime()).toBe(nextQuotaResetAt(waiting.lastRunAt).getTime())
        expect(waiting.consecutiveFailures ?? 0).toBe(0)
        expect((await latestRun(taskId)).additions).toBe(3)

        // The quota resets. Only the tracks still missing are searched, and the target is not cleared again.
        quota = Number.POSITIVE_INFINITY
        calls.searches.length = 0
        calls.removed.length = 0
        await runSyncTask(taskId, "scheduled")
        expect(calls.searches.map((search) => search.title)).toEqual(["Four", "Five", "Nowhere"])
        expect(calls.removed).toEqual([])
        expect(playlistTitles("youtube", "dst")).toEqual(titles.map((title) => `${title} (Official Video)`))

        // A track that was not found is not searched again on the next run.
        calls.searches.length = 0
        const result = await runSyncTask(taskId, "scheduled")
        expect(calls.searches).toEqual([])
        expect(result).toMatchObject({additions: 0, removals: 0, skipped: 1})
    })
})

describe("leases and interrupted runs", () => {
    test("marks runs left running by a crash as failed", async () => {
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst")})
        const otherTask = await insertTask({source: side("spotify", "src2"), destination: side("tidal", "dst2"), leaseId: "live", leaseExpiresAt: new Date(Date.now() + 60000)})
        const longAgo = new Date(Date.now() - 60 * 60 * 1000)
        await db.syncRuns.insertOne({taskId, status: "running", startedAt: longAgo})
        await db.syncRuns.insertOne({taskId: otherTask, status: "running", startedAt: longAgo})

        expect(await failInterruptedRuns()).toBe(1)
        expect((await latestRun(taskId)).status).toBe("failed")
        expect((await latestRun(otherTask)).status).toBe("running")

        // Taking the lease also clears a running row that a crash left behind.
        await db.syncRuns.insertOne({taskId, status: "running", startedAt: new Date()})
        setPlaylist("spotify", "src", "Source", [])
        setPlaylist("tidal", "dst", "Destination", [])
        const context = await beginSyncTask(taskId, "manual")
        const runs = (await db.syncRuns.find({taskId}).toArray()) as unknown as SyncRunDocument[]
        expect(runs.filter((run) => run.status === "running").map((run) => run._id!.toHexString())).toEqual([context.runId.toHexString()])
        await completeSyncTask(context)
    })

    test("keeps a full-sync lease at the heartbeat window", async () => {
        for (let index = 0; index < 40; index++) setPlaylist("spotify", `p${index}`, `Playlist ${index}`, [])
        const taskId = await insertTask({mode: "account", source: side("spotify", "__all__"), destination: side("tidal", "__all__")})
        let longest = 0
        beforeRead = () => {
            const task = db.syncTasks.store.find((doc) => (doc._id as ObjectId).equals(taskId))
            longest = Math.max(longest, ((task?.leaseExpiresAt as Date | undefined)?.getTime() || 0) - Date.now())
        }
        await runSyncTask(taskId, "scheduled")
        expect(longest).toBeLessThanOrEqual(15 * 60 * 1000)
    })
})

describe("restore and unavailable tracks", () => {
    test("keeps tracks preserved by a restore after many later runs", async () => {
        setPlaylist("tidal", "dst", "Mix", [track("tidal", "1", "Kept", "Artist")])
        setPlaylist("spotify", "src", "Mix", [])
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst")})
        const destinationItems = [{occurrenceId: "tidal:1", canonicalKey: "meta:kept:artist", title: "Kept", artists: ["Artist"], providerItemId: "tidal:1", providerTrackId: "tidal:1"}]
        await db.syncSnapshots.insertOne({taskId, sourceItems: [], destinationItems, preservedDestinationTracks: [{providerTrackId: "tidal:1", providerItemId: "tidal:1"}], createdAt: new Date()})
        for (let index = 0; index < 25; index++) await db.syncRuns.insertOne({taskId, status: "succeeded", startedAt: new Date(Date.now() - index)})

        await runSyncTask(taskId, "scheduled")
        expect(playlistTitles("tidal", "dst")).toEqual(["Kept"])
    })

    test("does not read an unavailable TIDAL track as a two-way deletion", async () => {
        const shared = track("spotify", "1", "Song", "Artist", "US0000000001")
        setPlaylist("spotify", "src", "Mix", [shared])
        setPlaylist("tidal", "dst", "Mix", [track("tidal", "1", "Song", "Artist", "US0000000001")])
        const taskId = await insertTask({direction: "two-way", source: side("spotify", "src"), destination: side("tidal", "dst")})
        await runSyncTask(taskId, "created")

        // The known entry keeps its place through the snapshot. The unknown one has nothing to search with and is left alone.
        catalogs.spotify = [track("spotify", "9", "Anything", "Artist")]
        setPlaylist("tidal", "dst", "Mix", [
            {itemId: "tidal:1", trackId: "tidal:1", title: "", artists: [], unavailable: true},
            {itemId: "tidal:2", trackId: "tidal:2", title: "", artists: [], unavailable: true}
        ])
        const result = await runSyncTask(taskId, "scheduled")

        expect(result).toMatchObject({additions: 0, removals: 0, skipped: 0})
        expect(calls.searches).toEqual([])
        expect(playlistTitles("spotify", "src")).toEqual(["Song"])
        expect(playlistTitles("tidal", "dst")).toHaveLength(2)
    })
})

describe("user action leases", () => {
    test("renews the lease while the action runs and releases it afterwards", async () => {
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst")})
        let firstExpiry = 0
        await withTaskLease(
            await storedTask(taskId),
            async () => {
                firstExpiry = (await storedTask(taskId)).leaseExpiresAt!.getTime()
                await new Promise((resolve) => setTimeout(resolve, 40))
                expect((await storedTask(taskId)).leaseExpiresAt!.getTime()).toBeGreaterThan(firstExpiry)
            },
            5
        )
        expect((await storedTask(taskId)).leaseId).toBeUndefined()
    })

    test("stops before its next write once another writer took the lease, and leaves that lease alone", async () => {
        const taskId = await insertTask({source: side("spotify", "src"), destination: side("tidal", "dst")})
        let wrote = false
        const action = withTaskLease(await storedTask(taskId), async (lease) => {
            await db.syncTasks.updateOne({_id: taskId}, {$set: {leaseId: "sync-run", leaseExpiresAt: new Date(Date.now() + 60000)}})
            await lease.assertHeld()
            wrote = true
        })

        await expect(action).rejects.toThrow("This sync task is still running")
        expect(wrote).toBe(false)
        expect((await storedTask(taskId)).leaseId).toBe("sync-run")
    })
})

describe("manual match snapshot rows", () => {
    test("links only the matched rows and leaves the rest of the baseline alone", () => {
        const row = (id: string, key: string) => ({occurrenceId: id, canonicalKey: key, title: id, artists: ["A"], providerItemId: id, providerTrackId: id})
        const items = [row("a", "key-a"), row("b", "key-b")]

        expect(linkSnapshotRow(items, {itemId: "b", trackId: "b", title: "b", artists: ["A"]}, "shared")).toEqual([row("a", "key-a"), row("b", "shared")])
        expect(linkSnapshotRow(items, {itemId: "c", trackId: "c", title: "c", artists: ["A"]}, "shared")).toEqual([...items, row("c", "shared")])
    })
})
