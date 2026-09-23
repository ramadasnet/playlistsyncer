import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {isEntitlementLocked, isPlanLockedTask, planTaskEntitlement, retainedFreeTierTask} from "../server/domain/billing/task-entitlement"
import {isComplimentaryTrialActive, parseSubscriptionRequiredAt, resolvePublicTrialCutoff} from "../shared/trial"

const first = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a1")
const second = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a2")
const account = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a3")
const created = {
    first: new Date("2026-01-01T00:00:00.000Z"),
    second: new Date("2026-02-01T00:00:00.000Z"),
    account: new Date("2025-12-01T00:00:00.000Z")
}

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

    test("keeps duplicate full syncs paused across plan changes", () => {
        const tasks = [
            {_id: first, mode: "playlist" as const, createdAt: created.first, pauseReason: undefined},
            {_id: account, mode: "account" as const, createdAt: created.account, pauseReason: "conflict" as const}
        ]

        expect(planTaskEntitlement(tasks, false)).toEqual({pauseIds: [], resumeIds: []})
        expect(planTaskEntitlement(tasks, true)).toEqual({pauseIds: [], resumeIds: []})
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
