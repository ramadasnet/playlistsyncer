import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {SyncRunDocument, SyncTaskDocument} from "../shared/types/domain"
import {availableReverseSync, readSyncFailureReason, reverseSyncRequestFor} from "../shared/reverse-sync"
import {serializeSyncRun} from "../server/domain/sync/history-visibility"

const deletedSourceRestore = reverseSyncRequestFor("deleted-source")
const now = new Date("2026-09-11T12:00:00.000Z")
const task = {
    _id: new ObjectId(),
    userId: new ObjectId(),
    mode: "playlist",
    direction: "one-way",
    source: {providerAccountId: new ObjectId(), playlistId: "src", name: "Source"},
    destination: {providerAccountId: new ObjectId(), playlistId: "dst", name: "Destination"},
    status: "active",
    nextRunAt: now,
    createdAt: now,
    updatedAt: now
} as SyncTaskDocument

function runDocument(overrides: Partial<SyncRunDocument> & Pick<SyncRunDocument, "status" | "startedAt">): SyncRunDocument {
    return {
        _id: new ObjectId(),
        taskId: task._id!,
        trigger: "manual",
        additions: 0,
        removals: 0,
        conflicts: 0,
        skipped: 0,
        addedTracks: [],
        removedTracks: [],
        unmatchedTracks: [],
        ...overrides
    }
}

describe("reverse sync offer", () => {
    test("offers a one-time reverse restore only for a deleted-source failure", () => {
        const deleted = runDocument({status: "failed", startedAt: now, failureReason: "deleted-source", error: "spotify API request failed (404)"})
        const unrelated = runDocument({status: "failed", startedAt: new Date(now.getTime() + 1000), error: "spotify API request failed (429)"})
        const succeeded = runDocument({status: "succeeded", startedAt: new Date(now.getTime() + 2000), reverseSync: deletedSourceRestore})

        expect(availableReverseSync(deleted)).toEqual(deletedSourceRestore)
        expect(availableReverseSync(unrelated)).toBeUndefined()
        expect(serializeSyncRun(unrelated).availableReverseSync).toBeUndefined()
        expect(serializeSyncRun(deleted, task, undefined, [unrelated]).availableReverseSync).toEqual(deletedSourceRestore)
        const partial = runDocument({status: "partial", startedAt: new Date(now.getTime() + 3000)})
        expect(serializeSyncRun(deleted, task, undefined, [succeeded]).availableReverseSync).toBeUndefined()
        expect(serializeSyncRun(deleted, task, undefined, [partial]).availableReverseSync).toBeUndefined()
        expect(availableReverseSync(deleted, [partial])).toBeUndefined()
        expect(serializeSyncRun(succeeded).reverseSync).toEqual(deletedSourceRestore)
        expect(serializeSyncRun(succeeded).availableReverseSync).toBeUndefined()
        expect(readSyncFailureReason({data: {failureReason: "deleted-source"}})).toBe("deleted-source")
        expect(readSyncFailureReason({data: {failureReason: "toString"}})).toBeUndefined()
        expect(readSyncFailureReason({data: {failureReason: "constructor"}})).toBeUndefined()
    })
})
