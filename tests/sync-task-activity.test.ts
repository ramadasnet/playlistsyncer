import {describe, expect, test} from "bun:test"
import {isInitialSyncPending, isSyncInProgress} from "../shared/sync-task-activity"

describe("sync task activity", () => {
    test("treats a running latest run as busy", () => {
        expect(isSyncInProgress({status: "active", lastRunAt: new Date(), latestRun: {status: "running"}})).toBe(true)
        expect(isSyncInProgress({status: "needs_attention", lastRunAt: "2026-01-01T00:00:00.000Z", latestRun: {status: "running"}})).toBe(true)
    })

    test("treats an unfinished first sync as busy", () => {
        expect(isInitialSyncPending({status: "active"})).toBe(true)
        expect(isSyncInProgress({status: "active", latestRun: {status: "succeeded"}})).toBe(true)
    })

    test("allows actions once the latest run has finished", () => {
        expect(isSyncInProgress({status: "active", lastRunAt: new Date(), latestRun: {status: "succeeded"}})).toBe(false)
        expect(isSyncInProgress({status: "active", lastRunAt: new Date(), latestRun: {status: "partial"}})).toBe(false)
        expect(isSyncInProgress({status: "active", lastRunAt: new Date(), latestRun: {status: "failed"}})).toBe(false)
        expect(isSyncInProgress({status: "paused"})).toBe(false)
        expect(isSyncInProgress({status: "paused", latestRun: {status: "succeeded"}})).toBe(false)
        expect(isInitialSyncPending({status: "paused"})).toBe(false)
    })
})
