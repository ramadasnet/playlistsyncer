import {describe, expect, mock, test} from "bun:test"
import {ObjectId, type Collection} from "mongodb"
import type {ProviderAccountDocument, SyncTaskDocument} from "../shared/types/domain"
import {backfillAccountSyncPairKeys} from "../server/data/account-sync-migration"

describe("legacy account sync migration", () => {
    test("keeps one provider-pair key and pauses duplicates without deleting them", async () => {
        const userId = new ObjectId()
        const sourceId = new ObjectId()
        const destinationId = new ObjectId()
        const now = new Date()
        const task = (source: ObjectId, destination: ObjectId): SyncTaskDocument => ({
            _id: new ObjectId(),
            userId,
            mode: "account",
            direction: "one-way",
            source: {providerAccountId: source, playlistId: "__all__", name: "Source"},
            destination: {providerAccountId: destination, playlistId: "__all__", name: "Destination"},
            status: "active",
            nextRunAt: now,
            createdAt: now,
            updatedAt: now
        })
        const rows = [task(sourceId, destinationId), task(destinationId, sourceId)]
        const find = mock(() => ({
            sort: () => ({
                async *[Symbol.asyncIterator]() {
                    for (const row of rows) {
                        if (!row.accountSyncPairKey && row.pauseReason !== "conflict") yield row
                    }
                }
            })
        }))
        const updateOne = mock(async (filter: {_id: ObjectId}, update: {$set: Partial<SyncTaskDocument>}) => {
            const row = rows.find((candidate) => candidate._id!.equals(filter._id))!
            if (update.$set.accountSyncPairKey && rows.some((candidate) => candidate !== row && candidate.accountSyncPairKey === update.$set.accountSyncPairKey)) {
                throw Object.assign(new Error("Duplicate pair"), {code: 11000})
            }
            Object.assign(row, update.$set)
        })
        const tasks = {find, updateOne} as unknown as Collection<SyncTaskDocument>
        const accounts = {
            findOne: mock(async (filter: {_id: ObjectId}) => {
                if (filter._id.equals(sourceId)) return {provider: "spotify"} as ProviderAccountDocument
                if (filter._id.equals(destinationId)) return {provider: "youtube"} as ProviderAccountDocument
                return null
            })
        } as unknown as Collection<ProviderAccountDocument>

        await backfillAccountSyncPairKeys(tasks, accounts)
        expect(rows).toHaveLength(2)
        expect(rows[0]?.accountSyncPairKey).toBe("spotify:youtube")
        expect(rows[1]).toMatchObject({status: "paused", pauseReason: "conflict"})
        expect(rows[1]?.accountSyncPairKey).toBeUndefined()

        await backfillAccountSyncPairKeys(tasks, accounts)
        expect(updateOne).toHaveBeenCalledTimes(3)
    })
})
