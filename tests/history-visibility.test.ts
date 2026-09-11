import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {canViewRunHistory, serializeSyncTask} from "../server/domain/sync/history-visibility"
import type {SyncTaskDocument} from "../shared/types/domain"

const now = new Date("2026-09-11T12:00:00.000Z")
const task: SyncTaskDocument = {
    _id: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a0"),
    userId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a1"),
    mode: "playlist",
    direction: "two-way",
    source: {providerAccountId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a2"), playlistId: "src", name: "Source"},
    destination: {providerAccountId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a3"), playlistId: "dst", name: "Destination"},
    status: "needs_attention",
    nextRunAt: now,
    lastRunAt: now,
    lastSuccessAt: now,
    lastError: "Needs a human ear",
    createdAt: now,
    updatedAt: now
}
const latestRun = {
    status: "partial" as const,
    additions: 3,
    removals: 1,
    conflicts: 2,
    skipped: 0,
    startedAt: now
}

describe("run history visibility", () => {
    test("is a PRO entitlement", () => {
        expect(canViewRunHistory("pro")).toBe(true)
        expect(canViewRunHistory("free")).toBe(false)
    })

    test("includes latest-run details for PRO accounts", () => {
        expect(serializeSyncTask(task, latestRun, "pro").latestRun).toEqual(latestRun)
    })

    test("hides latest-run details from Free accounts", () => {
        const summary = serializeSyncTask(task, latestRun, "free")

        expect(summary.latestRun).toBeUndefined()
        expect(summary.lastSuccessAt).toEqual(now)
        expect(summary.lastError).toBe("Needs a human ear")
        expect(summary.status).toBe("needs_attention")
    })
})
