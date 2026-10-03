import {describe, expect, test} from "bun:test"
import {accountSyncPairField} from "../server/domain/sync/account-sync-pair"
import {firestoreMongoOptions, firestoreUriDatabase, isDuplicateKeyError, isFirestoreMongoUri} from "../server/utils/mongodb"

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

    test("stores the provider pair only on a full sync", () => {
        expect(accountSyncPairField("playlist", "spotify:youtube")).toEqual({})
        expect(accountSyncPairField("account", "spotify:youtube")).toEqual({accountSyncPairKey: "spotify:youtube"})
    })

    test("recognizes MongoDB duplicate-key errors", () => {
        expect(isDuplicateKeyError({code: 11000})).toBe(true)
        expect(isDuplicateKeyError({codeName: "DuplicateKey"})).toBe(true)
        expect(isDuplicateKeyError({code: 121})).toBe(false)
        expect(isDuplicateKeyError(new Error("duplicate"))).toBe(false)
    })
})
