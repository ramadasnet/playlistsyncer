import {describe, expect, spyOn, test} from "bun:test"
import {ensureTtlIndexes} from "../server/data/collections"
import {accountSyncPairField, accountSyncPairStorageKey} from "../server/domain/sync/account-sync-pair"
import logger from "../server/utils/logger"
import {firestoreMongoOptions, firestoreUriDatabase, isDuplicateKeyError, isFirestoreMongoUri, isTtlJobPrivilegeError} from "../server/utils/mongodb"

const firestoreUri = "mongodb://f116f93a-519c-208a-9a72-3ef6c9a1f081.nam5.firestore.goog:443/playlistsync?loadBalanced=true&tls=true&retryWrites=false"

describe("Firestore MongoDB compatibility", () => {
    test("leaves a normal MongoDB URI on the default client settings", () => {
        const uri = "mongodb://localhost:27017/playlistsync"
        expect(isFirestoreMongoUri(uri)).toBe(false)
        expect(firestoreUriDatabase(uri)).toBeUndefined()
        expect(firestoreMongoOptions(uri)).toEqual({})
    })

    test("requires TLS and disables retryable writes for a Firestore URI", () => {
        expect(isFirestoreMongoUri(firestoreUri)).toBe(true)
        expect(firestoreUriDatabase(firestoreUri)).toBe("playlistsync")
        expect(firestoreMongoOptions(firestoreUri)).toEqual({retryWrites: false, tls: true})
    })

    test("stores a per-user provider pair only on a full sync", () => {
        expect(accountSyncPairStorageKey("user", "spotify:youtube")).toBe("user:spotify:youtube")
        expect(accountSyncPairField("playlist", "user", "spotify:youtube")).toEqual({})
        expect(accountSyncPairField("account", "user", "spotify:youtube")).toEqual({accountSyncPairKey: "user:spotify:youtube"})
    })

    test("recognizes MongoDB duplicate-key errors", () => {
        expect(isDuplicateKeyError({code: 11000})).toBe(true)
        expect(isDuplicateKeyError({codeName: "DuplicateKey"})).toBe(true)
        expect(isDuplicateKeyError({code: 121})).toBe(false)
        expect(isDuplicateKeyError(new Error("duplicate"))).toBe(false)
    })

    test("recognizes a missing CREATE JOB privilege on a TTL index", () => {
        const message = "Cannot create TTL indexes without CREATE JOB privilege"
        expect(isTtlJobPrivilegeError({code: 67, message})).toBe(true)
        expect(isTtlJobPrivilegeError({code: 67, errmsg: message})).toBe(true)
        expect(isTtlJobPrivilegeError({code: 67, message: "invalid index spec"})).toBe(false)
        expect(isTtlJobPrivilegeError({code: 85, message})).toBe(false)
        expect(isTtlJobPrivilegeError(new Error(message))).toBe(false)
    })
})

describe("TTL indexes", () => {
    function privilegeError() {
        return Promise.reject(Object.assign(new Error("Cannot create TTL indexes without CREATE JOB privilege"), {code: 67}))
    }

    test("continues when every TTL index lacks the CREATE JOB privilege", async () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
        try {
            await ensureTtlIndexes([privilegeError(), privilegeError()])
            expect(warn).toHaveBeenCalledWith("Database.indexes", "TTL indexes were not created because the database user lacks the CREATE JOB privilege. sync-cleanup deletes expired documents instead.")
        } finally {
            warn.mockRestore()
        }
    })

    test("still fails startup on any other index error", async () => {
        await expect(ensureTtlIndexes([privilegeError(), Promise.reject(Object.assign(new Error("invalid index spec"), {code: 67}))])).rejects.toThrow("invalid index spec")
    })
})
