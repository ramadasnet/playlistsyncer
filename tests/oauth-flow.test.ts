import {createServer} from "node:http"
import type {AddressInfo} from "node:net"
import * as h3 from "h3"
import {afterAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"

// The OAuth module relies on Nitro auto-imports; provide them from h3 and put the previous globals back afterwards.
const globals = globalThis as Record<string, unknown>
const nitroGlobals = {createError: h3.createError, getQuery: h3.getQuery, getRequestURL: h3.getRequestURL, getCookie: h3.getCookie, setCookie: h3.setCookie, deleteCookie: h3.deleteCookie}
const originalGlobals = Object.fromEntries(Object.keys(nitroGlobals).map((name) => [name, globals[name]]))
Object.assign(globals, nitroGlobals)

const data = await import("../server/data/collections")
const {collections, ensureIndexes} = data
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
const webhookCalls: {url: string; payload: Record<string, any>}[] = []
const tokenExchangeAuthorizations: string[] = []

// Webhooks are sent fire-and-forget, so assertions wait for the calls to land.
async function waitForWebhooks(count: number) {
    for (let attempt = 0; attempt < 200 && webhookCalls.length < count; attempt++) {
        await Bun.sleep(5)
    }
}

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
// Skip the listen when MongoDB is unset: the suite does not run, and its afterAll would not close the port.
const baseUrl = mongoUri
    ? await new Promise<string>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
      })
    : "http://127.0.0.1"

// Keep cookies per simulated browser so the flow can start in one browser and end in another.
function oauthCookieNames(browser: Browser): string[] {
    return [...browser.cookies.keys()].filter((name) => name.startsWith("ps_oauth_"))
}

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
        return (await this.beginDetails()).state
    }

    // Start a Spotify login or link and return the state and the picked app credentials.
    async beginDetails(): Promise<{state: string; clientId: string}> {
        const response = await this.get("/api/auth/spotify")
        expect(response.status).toBe(302)
        const location = new URL(response.headers.get("location")!)
        return {state: location.searchParams.get("state")!, clientId: location.searchParams.get("client_id")!}
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
    const {insertedId} = await db.users.insertOne({...fields, displayName: "OAuth flow", createdAt: now, updatedAt: now})
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
        Object.assign(config, {
            appUrl: baseUrl,
            spotifyCredentials: [{clientId: "spotify-client", clientSecret: "spotify-secret"}],
            spotifyMaxUsersPerApp: 5,
            userWebhookUrls: [],
            sessionSecret: config.sessionSecret || "oauth-flow-session",
            tokenEncryptionKey: config.tokenEncryptionKey || "oauth-flow-key"
        })
        webhookCalls.length = 0
        tokenExchangeAuthorizations.length = 0
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
        providerRateLimiters.set("spotify", new ProviderRateLimiter("spotify", 0, {cooldownMs: 0}))
        spotifyProfile = {id: `listener-${new ObjectId().toHexString()}`, display_name: "Listener"}
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input)
            if (url === "https://accounts.spotify.com/api/token") {
                tokenExchangeAuthorizations.push(new Headers(init?.headers).get("authorization") || "")
                return new Response(JSON.stringify({access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600}))
            }
            if (url.startsWith("https://webhook.example.test/")) {
                webhookCalls.push({url, payload: JSON.parse(typeof init?.body === "string" ? init.body : "{}")})
                return new Response("{}", {status: 200})
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
        for (const [name, value] of Object.entries(originalGlobals)) {
            if (value === undefined) delete globals[name]
            else globals[name] = value
        }
        await closeDatabase()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    test("redirects an OAuth start to the callback origin before setting a browser cookie", async () => {
        config.appUrl = "https://dev.playlistsyncer.test"
        const browser = new Browser()

        const response = await browser.get("/api/auth/spotify?redirect=%2Ftasks%3Fpage%3D2")

        expect(response.status).toBe(302)
        const location = new URL(response.headers.get("location")!)
        expect(location.origin).toBe(config.appUrl)
        expect(location.pathname).toBe("/api/auth/spotify")
        expect(location.searchParams.get("redirect")).toBe("/tasks?page=2")
        expect(oauthCookieNames(browser)).toHaveLength(0)
    })

    test("rejects a callback opened in a browser that did not start the flow", async () => {
        const attacker = new Browser()
        const victim = new Browser()
        const state = await attacker.begin()
        expect(oauthCookieNames(attacker)).toHaveLength(1)

        const forged = await victim.callback(state)

        expect(forged.status).toBe(400)
        expect(victim.cookies.has("ps_session")).toBe(false)
        expect(oauthCookieNames(attacker)).toHaveLength(1)

        // The rejected attempt does not consume the transaction of the browser that owns it.
        const own = await attacker.callback(state)
        expect(own.status).toBe(200)
        expect(await trackSessionUser(attacker)).toBeDefined()
        expect(oauthCookieNames(attacker)).toHaveLength(0)
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

    test("completes two OAuth flows started from the same browser", async () => {
        const browser = new Browser()
        const first = await browser.begin()
        const second = await browser.begin()
        expect(first).not.toBe(second)
        expect(oauthCookieNames(browser)).toHaveLength(2)

        const rejected = await browser.callback("unrelated-state")
        expect(rejected.status).toBe(400)
        expect(oauthCookieNames(browser)).toHaveLength(2)

        expect((await browser.callback(first)).status).toBe(200)
        expect(oauthCookieNames(browser)).toHaveLength(1)
        expect((await browser.callback(second)).status).toBe(200)
        expect(oauthCookieNames(browser)).toHaveLength(0)
        expect(await trackSessionUser(browser)).toBeDefined()
    })

    test("does not save tokens or a session when the user is deleted before the account is stored", async () => {
        const owner = await createUser()
        const externalId = spotifyProfile.id as string
        const db = await collections()
        const now = new Date()
        await db.providerAccounts.insertOne({
            userId: owner,
            provider: "spotify",
            externalAccountId: externalId,
            emailVerified: false,
            displayName: "Listener",
            accessToken: {version: 2, iv: "iv", ciphertext: "ciphertext"},
            scopes: [],
            connectedAt: now,
            updatedAt: now
        })
        const realCollections = data.collections
        let continueLookup: () => void = () => undefined
        const continueGate = new Promise<void>((resolve) => {
            continueLookup = resolve
        })
        let reached: () => void = () => undefined
        const reachedGate = new Promise<void>((resolve) => {
            reached = resolve
        })
        let paused = false
        const collectionsSpy = spyOn(data, "collections").mockImplementation(async () => {
            const current = await realCollections()
            const findOne = current.users.findOne.bind(current.users)
            current.users.findOne = (async (filter, options) => {
                const user = await findOne(filter, options)
                if (user?._id?.equals(owner) && !paused) {
                    paused = true
                    reached()
                    await continueGate
                }
                return user
            }) as typeof current.users.findOne
            return current
        })
        const browser = new Browser()

        try {
            const pending = browser.callback(await browser.begin())
            await Promise.race([reachedGate, new Promise((_, reject) => setTimeout(() => reject(new Error("OAuth did not load the user")), 3_000))])
            const fresh = await realCollections()
            await Promise.all([fresh.users.deleteOne({_id: owner}), fresh.providerAccounts.deleteMany({userId: owner}), fresh.sessions.deleteMany({userId: owner})])
            continueLookup()

            expect((await pending).status).toBe(401)
            expect(browser.cookies.has("ps_session")).toBe(false)
            expect(await fresh.users.countDocuments({_id: owner})).toBe(0)
            expect(await fresh.providerAccounts.countDocuments({provider: "spotify", externalAccountId: externalId})).toBe(0)
            expect(await fresh.sessions.countDocuments({userId: owner})).toBe(0)
        } finally {
            continueLookup()
            collectionsSpy.mockRestore()
        }
    })

    test("registers new users under the first Spotify app until its limit, then rotates", async () => {
        config.spotifyCredentials.push({clientId: "spotify-client-2", clientSecret: "spotify-secret-2"})
        config.spotifyMaxUsersPerApp = 1
        const db = await collections()
        // Users from earlier tests already hold the first app; drop the field so the limit starts clean.
        await db.users.updateMany({}, {$unset: {spotifyClientId: ""}})
        const first = new Browser()
        const second = new Browser()

        const firstBegin = await first.beginDetails()
        expect(firstBegin.clientId).toBe("spotify-client")
        expect((await first.callback(firstBegin.state)).status).toBe(200)
        const firstUser = await trackSessionUser(first)
        expect((await db.users.findOne({_id: firstUser}))?.spotifyClientId).toBe("spotify-client")
        expect((await db.providerAccounts.findOne({userId: firstUser}))?.oauthClientId).toBe("spotify-client")
        // The browser cookie binds the user to its app even after the app filled up.
        expect(first.cookies.get("ps_spotify_client")).toBe("spotify-client")

        spotifyProfile = {...spotifyProfile, id: `listener-${new ObjectId().toHexString()}`}
        const secondBegin = await second.beginDetails()
        expect(secondBegin.clientId).toBe("spotify-client-2")
        expect((await second.callback(secondBegin.state)).status).toBe(200)
        const secondUser = await trackSessionUser(second)
        expect((await db.users.findOne({_id: secondUser}))?.spotifyClientId).toBe("spotify-client-2")

        const basic = (clientId: string, clientSecret: string) => `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
        expect(tokenExchangeAuthorizations).toEqual([basic("spotify-client", "spotify-secret"), basic("spotify-client-2", "spotify-secret-2")])
    })

    test("reuses the browser's Spotify app on the next login and the linking user's app", async () => {
        config.spotifyCredentials.push({clientId: "spotify-client-2", clientSecret: "spotify-secret-2"})
        config.spotifyMaxUsersPerApp = 1
        const db = await collections()
        await db.users.updateMany({}, {$unset: {spotifyClientId: ""}})
        const first = new Browser()
        await first.callback(await first.begin())
        expect((await first.beginDetails()).clientId).toBe("spotify-client")

        // A signed-in user that already belongs to the second app keeps it when linking again.
        const linkedUser = await createUser()
        await db.users.updateOne({_id: linkedUser}, {$set: {spotifyClientId: "spotify-client-2"}})
        const linking = new Browser()
        await linking.signIn(linkedUser)
        expect((await linking.beginDetails()).clientId).toBe("spotify-client-2")
    })

    test("posts registration, login, and deletion events to the configured webhooks", async () => {
        config.userWebhookUrls = ["https://webhook.example.test/hook"]
        const browser = new Browser()

        expect((await browser.callback(await browser.begin())).status).toBe(200)
        await waitForWebhooks(2)
        expect(webhookCalls.map((call) => call.payload.event)).toEqual(["user.registered", "user.login"])
        expect(webhookCalls[0]!.payload.user).toMatchObject({displayName: "Listener", spotifyClientId: "spotify-client"})
        const userId = await trackSessionUser(browser)

        // A returning login notifies only the login event.
        webhookCalls.length = 0
        const again = new Browser()
        expect((await again.callback(await again.begin())).status).toBe(200)
        await waitForWebhooks(1)
        expect(webhookCalls.map((call) => call.payload.event)).toEqual(["user.login"])

        // Linking an account from an existing session is not a fresh login.
        webhookCalls.length = 0
        const linkingUser = await createUser()
        const linking = new Browser()
        await linking.signIn(linkingUser)
        spotifyProfile = {...spotifyProfile, id: `listener-${new ObjectId().toHexString()}`}
        expect((await linking.callback(await linking.begin())).status).toBe(200)
        await Bun.sleep(20)
        expect(webhookCalls).toHaveLength(0)

        // Account deletion posts the removed user's details.
        const {deleteUserAccount} = await import("../server/domain/accounts")
        const db = await collections()
        await deleteUserAccount((await db.users.findOne({_id: userId}))!)
        await waitForWebhooks(1)
        expect(webhookCalls.map((call) => call.payload.event)).toEqual(["user.deleted"])
        expect(webhookCalls[0]!.payload.user.id).toBe(userId!.toHexString())
    })
})
