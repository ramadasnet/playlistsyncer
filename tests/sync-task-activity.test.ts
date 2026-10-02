import {describe, expect, test} from "bun:test"
import {idleLeaseFilter} from "../server/domain/sync/task-activity"
import {isAwaitingFirstSync, isInitialSyncPending, isSyncInProgress, syncLeaseDurationMs} from "../shared/sync-task-activity"

const now = Date.parse("2026-10-01T12:00:00.000Z")

describe("sync task activity", () => {
    test("treats a live lease or a current running run as busy", () => {
        expect(isSyncInProgress({leaseExpiresAt: new Date(now + 60_000)}, now)).toBe(true)
        expect(isSyncInProgress({latestRun: {status: "running", startedAt: new Date(now - 60_000)}}, now)).toBe(true)
        expect(isSyncInProgress({latestRun: {status: "running", startedAt: new Date(now - 1_000).toISOString()}}, now)).toBe(true)
    })

    test("lets the owner recover an expired lease, an abandoned run, or a first sync that never finished", () => {
        expect(isInitialSyncPending({status: "active"})).toBe(true)
        expect(isSyncInProgress({}, now)).toBe(false)
        expect(isSyncInProgress({leaseExpiresAt: new Date(now - 1), latestRun: {status: "running", startedAt: new Date(now - syncLeaseDurationMs - 1)}}, now)).toBe(false)
        expect(isSyncInProgress({latestRun: {status: "running"}}, now)).toBe(false)
        expect(isAwaitingFirstSync({status: "active", createdAt: new Date(now - syncLeaseDurationMs - 1)}, now)).toBe(false)
    })

    test("keeps watching a first sync only while it could still be starting", () => {
        expect(isAwaitingFirstSync({status: "active", createdAt: new Date(now - 1_000)}, now)).toBe(true)
        expect(isAwaitingFirstSync({status: "active", lastRunAt: new Date(now), createdAt: new Date(now)}, now)).toBe(false)
        expect(isAwaitingFirstSync({status: "paused", createdAt: new Date(now)}, now)).toBe(false)
    })

    test("allows actions once the latest run has finished", () => {
        expect(isSyncInProgress({latestRun: {status: "succeeded", startedAt: new Date(now)}}, now)).toBe(false)
        expect(isSyncInProgress({latestRun: {status: "partial", startedAt: new Date(now)}}, now)).toBe(false)
        expect(isSyncInProgress({latestRun: {status: "failed", startedAt: new Date(now)}}, now)).toBe(false)
        expect(isSyncInProgress({}, now)).toBe(false)
        expect(isInitialSyncPending({status: "paused"})).toBe(false)
    })

    test("requires the lease to be missing or expired before a mutation", () => {
        const at = new Date(now)
        expect(idleLeaseFilter(at)).toEqual({$or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lte: at}}]})
    })
})
