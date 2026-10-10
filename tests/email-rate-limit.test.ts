import {afterAll, describe, expect, test} from "bun:test"
import {collections, ensureIndexes} from "../server/data/collections"
import {emailConfirmationsPerHour, requestEmailConfirmation} from "../server/domain/auth/email"
import {newUserFromOAuthProfile} from "../server/domain/auth/oauth"
import type {OutboundEmail} from "../server/domain/mail/send"
import {closeDatabase} from "../server/utils/database"

const mongoUri = process.env.PLS_MONGODB_URI

describe.skipIf(!mongoUri)("confirmation email limit against MongoDB", () => {
    afterAll(async () => {
        await closeDatabase()
    })

    test("caps confirmation emails per user even when every address differs", async () => {
        await ensureIndexes()
        const db = await collections()
        const {insertedId: userId} = await db.users.insertOne(newUserFromOAuthProfile({id: "email-limit", emailVerified: false, displayName: "Email Limit"}, new Date()))
        const sent: OutboundEmail[] = []
        const options = {
            appUrl: "http://localhost:3007",
            secret: "email-limit-test-secret",
            nodeEnv: "test",
            send: async (message: OutboundEmail) => {
                sent.push(message)
                return true
            }
        }
        const address = (index: number) => `limit-${index}-${userId.toHexString()}@playlistsyncer.test`

        try {
            for (let index = 0; index < emailConfirmationsPerHour; index++) {
                await requestEmailConfirmation((await db.users.findOne({_id: userId}))!, address(index), options)
            }
            const user = (await db.users.findOne({_id: userId}))!

            await expect(requestEmailConfirmation(user, address(emailConfirmationsPerHour), options)).rejects.toMatchObject({statusCode: 429})
            expect(sent).toHaveLength(emailConfirmationsPerHour)
            expect((await db.users.findOne({_id: userId}))?.tempEmail).toBe(address(emailConfirmationsPerHour - 1))
        } finally {
            await db.users.deleteOne({_id: userId})
        }
    })
})
