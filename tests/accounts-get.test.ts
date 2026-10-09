import {afterAll, describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import * as data from "../server/data/collections"
import * as session from "../server/domain/auth/session"
import * as tokens from "../server/domain/providers/token"
import * as rateLimit from "../server/utils/user-rate-limit"

const globals = globalThis as Record<string, unknown>
const originalGetQuery = globals.getQuery
let query: Record<string, string> = {}
globals.defineEventHandler = (handler: unknown) => handler
globals.getQuery = () => query

const {default: listAccounts} = await import("../server/api/accounts.get")
const list = listAccounts as (event: unknown) => Promise<{accounts: unknown[]}>

function user() {
    return {
        _id: new ObjectId(),
        displayName: "List",
        tier: "free" as const,
        createdAt: new Date(),
        updatedAt: new Date()
    }
}

describe("account list provider limit", () => {
    afterAll(() => {
        if (originalGetQuery === undefined) {
            delete globals.getQuery
        } else {
            globals.getQuery = originalGetQuery
        }
    })

    test("plain account list does not refresh tokens or count against the limit", async () => {
        query = {}
        const requireUser = spyOn(session, "requireUser").mockResolvedValue(user() as Awaited<ReturnType<typeof session.requireUser>>)
        const refresh = spyOn(tokens, "ensureFreshAccessTokens").mockResolvedValue(undefined)
        const limit = spyOn(rateLimit, "enforceProviderRequestLimit").mockImplementation(() => undefined)
        const db = spyOn(data, "collections").mockResolvedValue({providerAccounts: {find: () => ({toArray: async () => []})}} as never)
        try {
            await expect(list({})).resolves.toEqual({accounts: []})
            expect(refresh).not.toHaveBeenCalled()
            expect(limit).not.toHaveBeenCalled()
        } finally {
            requireUser.mockRestore()
            refresh.mockRestore()
            limit.mockRestore()
            db.mockRestore()
        }
    })

    test("playlist counts apply the limit before refreshing tokens", async () => {
        query = {includePlaylistCount: "true"}
        const order: string[] = []
        const requireUser = spyOn(session, "requireUser").mockResolvedValue(user() as Awaited<ReturnType<typeof session.requireUser>>)
        const limit = spyOn(rateLimit, "enforceProviderRequestLimit").mockImplementation(() => {
            order.push("limit")
        })
        const refresh = spyOn(tokens, "ensureFreshAccessTokens").mockImplementation(async () => {
            order.push("refresh")
        })
        const db = spyOn(data, "collections").mockResolvedValue({providerAccounts: {find: () => ({toArray: async () => []})}} as never)
        try {
            await list({})
            expect(order).toEqual(["limit", "refresh"])
        } finally {
            requireUser.mockRestore()
            refresh.mockRestore()
            limit.mockRestore()
            db.mockRestore()
        }
    })

    test("stops before token refresh when the limit rejects the request", async () => {
        query = {includePlaylistCount: "true"}
        const requireUser = spyOn(session, "requireUser").mockResolvedValue(user() as Awaited<ReturnType<typeof session.requireUser>>)
        const limit = spyOn(rateLimit, "enforceProviderRequestLimit").mockImplementation(() => {
            throw {statusCode: 429, statusMessage: "Too many music provider requests. Wait a minute and try again."}
        })
        const refresh = spyOn(tokens, "ensureFreshAccessTokens").mockResolvedValue(undefined)
        const db = spyOn(data, "collections").mockResolvedValue({providerAccounts: {find: () => ({toArray: async () => []})}} as never)
        try {
            await expect(list({})).rejects.toMatchObject({statusCode: 429})
            expect(refresh).not.toHaveBeenCalled()
            expect(db).not.toHaveBeenCalled()
        } finally {
            requireUser.mockRestore()
            refresh.mockRestore()
            limit.mockRestore()
            db.mockRestore()
        }
    })
})
