import {createServer} from "node:http"
import type {AddressInfo} from "node:net"
import * as h3 from "h3"
import {afterAll, beforeEach, describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"

Object.assign(globalThis as Record<string, unknown>, {
    createError: h3.createError,
    getQuery: h3.getQuery,
    getCookie: h3.getCookie,
    setCookie: h3.setCookie,
    deleteCookie: h3.deleteCookie
})

const {collections, ensureIndexes} = await import("../server/data/collections")
const {beginOAuth, finishOAuth} = await import("../server/domain/auth/oauth")
const {hashOpaqueToken} = await import("../server/domain/auth/session")
const {ProviderRateLimiter, providerRateLimiters} = await import("../server/domain/providers/rate-limit")
const {getServerConfig} = await import("../server/utils/config")
const {closeDatabase} = await import("../server/utils/database")
const {fetchRetryDefaults} = await import("../server/utils/fetch-retry")

const mongoUri = process.env.PLS_MONGODB_URI
const config = getServerConfig()
const originalConfig = {...config}
const originalFetch = globalThis.fetch
const originalRetryDefaults = {...fetchRetryDefaults}
const runId = new ObjectId().toHexString()
const createdUserIds: ObjectId[] = []
let spotifyProfile: Record<string, unknown> = {}

const app = h3.createApp()
app.use(
    h3
        .createRouter()
        .get(
            "/api/auth/spotify",
            h3.defineEventHandler(async (event) => h3.sendRedirect(event, await beginOAuth(event, "spotify")))
        )
        .get(
            "/api/auth/spotify/callback",
            h3.defineEventHandler(async (event) => {
                const query = h3.getQuery(event)
                return {redirect: await finishOAuth(event, "spotify", String(query.code), String(query.state))}
            })
        )
)
const server = createServer(h3.toNodeListener(app))
const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
})

// Keep cookies per simulated browser so the flow can start in one browser and end in another.
class Browser {
    readonly cookies = new Map<string, string>()

    async get(path: string): Promise<Response> {
        const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
        const response = await originalFetch(`${baseUrl}${path}`, {redirect: "manual", headers: cookie ? {cookie} : {}})
        for (const header of response.headers.getSetCookie()) {
            const [pair = ""] = header.split(";")
            const separator = pair.indexOf("=")
            const name = pair.slice(0, separator)
            const value = pair.slice(separator + 1)
            if (!value || /max-age=0/i.test(header)) {
                this.cookies.delete(name)
            } else {
                this.cookies.set(name, value)
            }
        }
        return response
    }

    // Start a Spotify login or link and return the state the provider would send back.
    async begin(): Promise<string> {
        const response = await this.get("/api/auth/spotify")
        expect(response.status).toBe(302)
        return new URL(response.headers.get("location")!).searchParams.get("state")!
    }

    callback(state: string): Promise<Response> {
        return this.get(`/api/auth/spotify/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    }

    async sessionUserId(): Promise<ObjectId | undefined> {
        const token = this.cookies.get("ps_session")
        if (!token) return undefined
        const db = await collections()
        return (await db.sessions.findOne({tokenHash: hashOpaqueToken(token)}))?.userId
    }

    async signIn(userId: ObjectId): Promise<void> {
        const token = new ObjectId().toHexString()
        const db = await collections()
        const now = new Date()
        await db.sessions.insertOne({userId, tokenHash: hashOpaqueToken(token), createdAt: now, expiresAt: new Date(now.getTime() + 60_000)})
        this.cookies.set("ps_session", token)
    }
}

async function createUser(fields: {email?: string} = {}): Promise<ObjectId> {
    const db = await collections()
    const now = new Date()
    const {insertedId} = await db.users.insertOne({...fields, displayName: "OAuth flow", tier: "free", createdAt: now, updatedAt: now})
    createdUserIds.push(insertedId)
    return insertedId
}

async function trackSessionUser(browser: Browser): Promise<ObjectId | undefined> {
    const userId = await browser.sessionUserId()
    if (userId) createdUserIds.push(userId)
    return userId
}

describe.skipIf(!mongoUri)("OAuth callback binding against MongoDB", () => {
    beforeEach(async () => {
        await ensureIndexes()
        Object.assign(config, {spotifyClientId: "spotify-client", spotifyClientSecret: "spotify-secret", sessionSecret: config.sessionSecret || "oauth-flow-session", tokenEncryptionKey: config.tokenEncryptionKey || "oauth-flow-key"})
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
        providerRateLimiters.set("spotify", new ProviderRateLimiter("spotify", 0, {cooldownMs: 0}))
        spotifyProfile = {id: `listener-${new ObjectId().toHexString()}`, display_name: "Listener"}
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input)
            if (url === "https://accounts.spotify.com/api/token") {
                return new Response(JSON.stringify({access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600}))
            }
            if (url === "https://api.spotify.com/v1/me") {
                return new Response(JSON.stringify(spotifyProfile))
            }
            return originalFetch(input, init)
        }) as typeof fetch
    })

    afterAll(async () => {
        const db = await collections()
        await Promise.all([db.providerAccounts.deleteMany({userId: {$in: createdUserIds}}), db.sessions.deleteMany({userId: {$in: createdUserIds}}), db.users.deleteMany({_id: {$in: createdUserIds}})])
        Object.assign(config, originalConfig)
        Object.assign(fetchRetryDefaults, originalRetryDefaults)
        globalThis.fetch = originalFetch
        providerRateLimiters.delete("spotify")
        await closeDatabase()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    test("rejects a callback opened in a browser that did not start the flow", async () => {
        const attacker = new Browser()
        const victim = new Browser()
        const state = await attacker.begin()
        expect(attacker.cookies.has("ps_oauth")).toBe(true)

        const forged = await victim.callback(state)

        expect(forged.status).toBe(400)
        expect(victim.cookies.has("ps_session")).toBe(false)

        // The rejected attempt does not consume the transaction of the browser that owns it.
        const own = await attacker.callback(state)
        expect(own.status).toBe(200)
        expect(await trackSessionUser(attacker)).toBeDefined()
        expect(attacker.cookies.has("ps_oauth")).toBe(false)
    })

    test("refuses to link when the signed-in user changed after the flow started", async () => {
        const linkingUser = await createUser()
        const otherUser = await createUser()
        const browser = new Browser()
        await browser.signIn(linkingUser)
        const state = await browser.begin()

        await browser.signIn(otherUser)
        const switched = await browser.callback(state)

        expect(switched.status).toBe(401)
        const db = await collections()
        expect(await db.providerAccounts.countDocuments({provider: "spotify", externalAccountId: spotifyProfile.id as string})).toBe(0)
        expect(await browser.sessionUserId()).toEqual(otherUser)
    })

    test("refuses to link when the session ended after the flow started", async () => {
        const linkingUser = await createUser()
        const browser = new Browser()
        await browser.signIn(linkingUser)
        const state = await browser.begin()

        browser.cookies.delete("ps_session")
        const response = await browser.callback(state)

        expect(response.status).toBe(401)
        expect(browser.cookies.has("ps_session")).toBe(false)
    })

    test("links the provider account to the user who started the flow", async () => {
        const linkingUser = await createUser()
        const browser = new Browser()
        await browser.signIn(linkingUser)
        const state = await browser.begin()

        const response = await browser.callback(state)

        expect(response.status).toBe(200)
        const db = await collections()
        const account = await db.providerAccounts.findOne({provider: "spotify", externalAccountId: spotifyProfile.id as string})
        expect(account?.userId).toEqual(linkingUser)
        expect(await browser.sessionUserId()).toEqual(linkingUser)
    })

    test("never signs in to an existing user through an unverified Spotify email", async () => {
        const victimEmail = `victim-${runId}@playlistsyncer.test`
        const victim = await createUser({email: victimEmail})
        spotifyProfile = {...spotifyProfile, email: victimEmail}
        const attacker = new Browser()

        const response = await attacker.callback(await attacker.begin())

        expect(response.status).toBe(200)
        const sessionUser = await trackSessionUser(attacker)
        expect(sessionUser).toBeDefined()
        expect(sessionUser).not.toEqual(victim)
        const db = await collections()
        expect((await db.users.findOne({_id: sessionUser}))?.email).toBeUndefined()
    })

    test("re-keys a Spotify account stored under the mutable user id", async () => {
        const owner = await createUser()
        const legacyId = spotifyProfile.id as string
        const accountId = `account-${new ObjectId().toHexString()}`
        const db = await collections()
        const now = new Date()
        const {insertedId} = await db.providerAccounts.insertOne({
            userId: owner,
            provider: "spotify",
            externalAccountId: legacyId,
            emailVerified: false,
            displayName: "Listener",
            accessToken: {version: 2, iv: "iv", ciphertext: "ciphertext"},
            scopes: [],
            connectedAt: now,
            updatedAt: now
        })
        spotifyProfile = {...spotifyProfile, account_id: accountId}
        const browser = new Browser()

        const response = await browser.callback(await browser.begin())

        expect(response.status).toBe(200)
        expect(await browser.sessionUserId()).toEqual(owner)
        const accounts = await db.providerAccounts.find({provider: "spotify", externalAccountId: {$in: [legacyId, accountId]}}).toArray()
        expect(accounts.map((account) => [account._id.toHexString(), account.externalAccountId])).toEqual([[insertedId.toHexString(), accountId]])
    })
})
