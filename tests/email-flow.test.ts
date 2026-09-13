import {afterAll, describe, expect, test} from "bun:test"
import {collections, ensureIndexes} from "../server/data/collections"
import {confirmEmail, requestEmailConfirmation} from "../server/domain/auth/email"
import {newUserFromOAuthProfile} from "../server/domain/auth/oauth"
import type {OutboundEmail} from "../server/domain/mail/send"
import {closeDatabase} from "../server/utils/database"

const mongoUri = process.env.MONGODB_URI
const secret = "email-flow-test-secret"

describe.skipIf(!mongoUri)("email confirmation against MongoDB", () => {
    afterAll(async () => {
        await closeDatabase()
    })

    test("keeps the address as tempEmail until the confirmation link is used", async () => {
        await ensureIndexes()
        const db = await collections()
        const now = new Date()
        const inserted = await db.users.insertOne(newUserFromOAuthProfile({id: "flow-1", emailVerified: false, displayName: "Email Flow"}, now))
        const userId = inserted.insertedId
        const address = `flow-${userId.toHexString()}@playlistsyncer.test`
        const sent: OutboundEmail[] = []

        try {
            const created = (await db.users.findOne({_id: userId}))!
            expect(created.email).toBeUndefined()

            const requested = await requestEmailConfirmation(created, address, {
                appUrl: "http://localhost:3007",
                secret,
                nodeEnv: "test",
                send: async (message) => {
                    sent.push(message)
                    return false
                }
            })

            const pending = (await db.users.findOne({_id: userId}))!
            expect(pending.email).toBeUndefined()
            expect(pending.tempEmail).toBe(address)
            expect(requested.devConfirmationUrl).toContain("/confirm-email?token=")
            expect(sent).toHaveLength(1)

            const token = new URL(requested.devConfirmationUrl!).searchParams.get("token")
            expect(token).toBeTruthy()

            await confirmEmail(token!, {secret})

            const confirmed = (await db.users.findOne({_id: userId}))!
            expect(confirmed.email).toBe(address)
            expect(confirmed.tempEmail).toBeUndefined()
            expect(confirmed.emailVerificationTokenHash).toBeUndefined()
        } finally {
            await db.users.deleteOne({_id: userId})
        }
    })

    test("allows more than one user without a confirmed email", async () => {
        await ensureIndexes()
        const db = await collections()
        const now = new Date()
        const first = await db.users.insertOne(newUserFromOAuthProfile({id: "flow-a", emailVerified: false, displayName: "A"}, now))
        const second = await db.users.insertOne(newUserFromOAuthProfile({id: "flow-b", emailVerified: false, displayName: "B"}, now))
        try {
            expect(await db.users.find({_id: {$in: [first.insertedId, second.insertedId]}}).toArray()).toHaveLength(2)
        } finally {
            await db.users.deleteMany({_id: {$in: [first.insertedId, second.insertedId]}})
        }
    })
})
