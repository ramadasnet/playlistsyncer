import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {SyncTaskDocument, UserDocument} from "../shared/types/domain"
import * as collectionsModule from "../server/data/collections"
import {clearServerConfigCache} from "../server/utils/config"
import {isEntitlementLocked, isPlanLockedTask, planTaskEntitlement, retainedFreeTierTask, revertExpiredPromotionalAccess} from "../server/domain/billing/task-entitlement"
import {isComplimentaryTrialActive, parseSubscriptionRequiredAt, resolvePublicTrialCutoff} from "../shared/trial"

const first = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a1")
const second = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a2")
const account = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a3")
const created = {
    first: new Date("2026-01-01T00:00:00.000Z"),
    second: new Date("2026-02-01T00:00:00.000Z"),
    account: new Date("2025-12-01T00:00:00.000Z")
}

// In-memory users and sync tasks behind the promotional revert tests.
const users: UserDocument[] = []
const tasks: SyncTaskDocument[] = []

type Query = Record<string, unknown>

function sameValue(left: unknown, right: unknown): boolean {
    if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right)
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
    return left === right
}

function matchesQuery(doc: Query, filter: Query): boolean {
    return Object.entries(filter).every(([key, value]) => {
        if (key === "$or") return (value as Query[]).some((clause) => matchesQuery(doc, clause))
        const actual = doc[key]
        if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
            return Object.entries(value as Query).every(([operator, operand]) => {
                if (operator === "$exists") return operand ? actual !== undefined : actual === undefined
                if (operator === "$ne") return !sameValue(actual, operand)
                if (operator === "$nin") return !(operand as unknown[]).some((option) => sameValue(actual, option))
                const left = actual instanceof Date ? actual.getTime() : Number(actual)
                const right = operand instanceof Date ? operand.getTime() : Number(operand)
                if (operator === "$lt") return left < right
                if (operator === "$lte") return left <= right
                if (operator === "$gt") return left > right
                throw new Error(`Unsupported operator ${operator}`)
            })
        }
        return sameValue(actual, value)
    })
}

function applyUpdate(doc: Query, update: {$set?: Query; $unset?: Record<string, "">}) {
    Object.assign(doc, update.$set ?? {})
    for (const key of Object.keys(update.$unset ?? {})) delete doc[key]
}

const db = {
    users: {
        find: (filter: Query) => ({
            toArray: async () => users.filter((user) => matchesQuery(user as unknown as Query, filter))
        })
    },
    syncTasks: {
        find: (filter: Query) => ({
            sort: () => ({
                limit: () => ({
                    next: async () => {
                        const matched = tasks.filter((task) => matchesQuery(task as unknown as Query, filter))
                        matched.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
                        return matched[0] ?? null
                    }
                })
            })
        }),
        updateMany: async (filter: Query, update: {$set?: Query; $unset?: Record<string, "">}) => {
            const matched = tasks.filter((task) => matchesQuery(task as unknown as Query, filter))
            for (const task of matched) applyUpdate(task as unknown as Query, update)
            return {matchedCount: matched.length, modifiedCount: matched.length}
        },
        updateOne: async (filter: Query, update: {$set?: Query; $unset?: Record<string, "">}) => {
            const task = tasks.find((item) => matchesQuery(item as unknown as Query, filter))
            if (task) applyUpdate(task as unknown as Query, update)
            return {matchedCount: task ? 1 : 0, modifiedCount: task ? 1 : 0}
        }
    }
}

const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as unknown as Awaited<ReturnType<typeof collectionsModule.collections>>)
afterAll(() => collectionsSpy.mockRestore())

describe("complimentary trial window", () => {
    test("parses date-only and ISO cutoff values", () => {
        expect(parseSubscriptionRequiredAt("2027-01-01T00:00:00.000Z")?.toISOString()).toBe("2027-01-01T00:00:00.000Z")
        expect(parseSubscriptionRequiredAt("")).toBeUndefined()
        expect(parseSubscriptionRequiredAt("not-a-date")).toBeUndefined()
    })

    test("is active only before the configured instant", () => {
        const cutoff = "2027-01-01T00:00:00.000Z"
        expect(isComplimentaryTrialActive(cutoff, new Date("2026-12-31T23:59:59.000Z"))).toBe(true)
        expect(isComplimentaryTrialActive(cutoff, new Date("2027-01-01T00:00:00.000Z"))).toBe(false)
        expect(isComplimentaryTrialActive(undefined, new Date("2026-09-12T00:00:00.000Z"))).toBe(false)
    })

    test("prefers the runtime PLS_PRO_SUBSCRIPTION_REQUIRED_AT env var over a baked public value", () => {
        expect(resolvePublicTrialCutoff({PLS_PRO_SUBSCRIPTION_REQUIRED_AT: "2027-01-01T00:00:00.000Z"}, "2026-01-01T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z")
        expect(resolvePublicTrialCutoff({}, "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z")
        expect(resolvePublicTrialCutoff({PLS_PRO_SUBSCRIPTION_REQUIRED_AT: "  "}, "")).toBe("")
    })
})

describe("free-tier task retention", () => {
    test("keeps the earliest playlist-pair task", () => {
        const tasks = [
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: undefined},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: undefined},
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: undefined}
        ]

        expect(retainedFreeTierTask(tasks)?._id).toEqual(first)
    })

    test("pauses extra and account tasks when PRO is lost", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: "entitlement" as const},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: undefined},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: undefined}
        ]

        expect(planTaskEntitlement(tasks, false)).toEqual({
            pauseIds: [second, account],
            resumeIds: [first]
        })
        expect(isEntitlementLocked(tasks[0]!)).toBe(true)
    })

    test("does not force-resume a user-paused first playlist pair", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: "user" as const},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: undefined}
        ]

        expect(planTaskEntitlement(tasks, false)).toEqual({
            pauseIds: [second],
            resumeIds: []
        })
    })

    test("does not convert user-paused extra tasks into entitlement pauses", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: undefined},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: "user" as const},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: "user" as const}
        ]

        expect(planTaskEntitlement(tasks, false)).toEqual({
            pauseIds: [],
            resumeIds: []
        })
    })

    test("resumes entitlement-paused tasks when PRO is restored", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: "entitlement" as const},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: "entitlement" as const}
        ]

        expect(planTaskEntitlement(tasks, true)).toEqual({
            pauseIds: [],
            resumeIds: [first, second]
        })
    })

    test("restoring PRO leaves user-paused tasks paused", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: "entitlement" as const},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: "user" as const},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: "user" as const}
        ]

        expect(planTaskEntitlement(tasks, true)).toEqual({
            pauseIds: [],
            resumeIds: [first]
        })
    })

    test("does not re-pause tasks that are already entitlement-locked", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: undefined},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: "entitlement" as const},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: "entitlement" as const}
        ]

        expect(planTaskEntitlement(tasks, false)).toEqual({
            pauseIds: [],
            resumeIds: []
        })
    })

    test("locks extra user-paused tasks on Free without converting their pause reason", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: "user" as const},
            {_id: second, mode: "playlist" as const, createdAt: created.second, pauseReason: "user" as const},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: "user" as const}
        ]

        expect(isPlanLockedTask(tasks[0]!, tasks, false)).toBe(false)
        expect(isPlanLockedTask(tasks[1]!, tasks, false)).toBe(true)
        expect(isPlanLockedTask(tasks[2]!, tasks, false)).toBe(true)
        expect(isPlanLockedTask(tasks[1]!, tasks, true)).toBe(false)
    })
})

describe("promotional revert", () => {
    const savedCutoff = process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT

    beforeEach(() => {
        users.splice(0)
        tasks.splice(0)
    })

    afterEach(() => {
        if (savedCutoff === undefined) delete process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT
        else process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT = savedCutoff
        clearServerConfigCache()
    })

    function addUser(tier: "free" | "pro"): UserDocument {
        const user: UserDocument = {
            _id: new ObjectId(),
            email: `${tier}-${users.length}@example.com`,
            displayName: tier,
            tier,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
        }
        users.push(user)
        return user
    }

    function addTask(user: UserDocument, mode: "playlist" | "account", createdAt: Date): SyncTaskDocument {
        const task: SyncTaskDocument = {
            _id: new ObjectId(),
            userId: user._id!,
            mode,
            direction: "one-way",
            source: {providerAccountId: user._id!, playlistId: "src", name: "Source"},
            destination: {providerAccountId: user._id!, playlistId: "dst", name: "Destination"},
            status: "active",
            nextRunAt: new Date("2026-10-16T00:00:00.000Z"),
            createdAt,
            updatedAt: createdAt
        }
        tasks.push(task)
        return task
    }

    test("reverts accounts without a paid subscription once the complimentary window has ended", async () => {
        process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT = "2026-10-01T00:00:00.000Z"
        clearServerConfigCache()
        const promotional = addUser("free")
        const paid = addUser("pro")
        const kept = addTask(promotional, "playlist", new Date("2026-01-01T00:00:00.000Z"))
        const extra = addTask(promotional, "playlist", new Date("2026-02-01T00:00:00.000Z"))
        const full = addTask(promotional, "account", new Date("2026-03-01T00:00:00.000Z"))
        addTask(paid, "playlist", new Date("2026-01-01T00:00:00.000Z"))
        addTask(paid, "playlist", new Date("2026-02-01T00:00:00.000Z"))

        const result = await revertExpiredPromotionalAccess({now: new Date("2026-10-16T00:00:00.000Z")})

        expect(result).toEqual({users: 1, stopped: false})
        expect(kept.status).toBe("active")
        expect(kept.pauseReason).toBeUndefined()
        expect(extra).toMatchObject({status: "paused", pauseReason: "entitlement"})
        expect(full).toMatchObject({status: "paused", pauseReason: "entitlement"})
        expect(tasks.filter((task) => task.userId.equals(paid._id!)).every((task) => task.status === "active" && task.pauseReason === undefined)).toBe(true)
    })

    test("does nothing while the complimentary window is still active or unconfigured", async () => {
        process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT = "2027-01-01T00:00:00.000Z"
        clearServerConfigCache()
        const promotional = addUser("free")
        addTask(promotional, "playlist", new Date("2026-01-01T00:00:00.000Z"))
        addTask(promotional, "playlist", new Date("2026-02-01T00:00:00.000Z"))

        const active = await revertExpiredPromotionalAccess({now: new Date("2026-10-16T00:00:00.000Z")})
        expect(active).toEqual({users: 0, stopped: false})

        delete process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT
        clearServerConfigCache()
        const unconfigured = await revertExpiredPromotionalAccess({now: new Date("2026-10-16T00:00:00.000Z")})
        expect(unconfigured).toEqual({users: 0, stopped: false})
        expect(tasks.every((task) => task.status === "active" && task.pauseReason === undefined)).toBe(true)
    })

    test("stops before the next account when the process is shutting down", async () => {
        process.env.PLS_PRO_SUBSCRIPTION_REQUIRED_AT = "2026-10-01T00:00:00.000Z"
        clearServerConfigCache()
        addUser("free")
        addUser("free")

        let checks = 0
        const result = await revertExpiredPromotionalAccess({now: new Date("2026-10-16T00:00:00.000Z"), stopping: () => ++checks > 1})

        expect(result).toEqual({users: 1, stopped: true})
    })
})
