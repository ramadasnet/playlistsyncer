import {afterEach, describe, expect, spyOn, test} from "bun:test"
import {createApp, createError, defineEventHandler, toWebHandler} from "h3"
import {ObjectId} from "mongodb"
import * as database from "../server/utils/database"
import * as data from "../server/data/collections"
import * as activity from "../server/domain/sync/task-activity"
import * as billing from "../server/domain/billing/creem"
import {clearServerConfigCache} from "../server/utils/config"
import {adminConfig, isAllowedAdmin, parseAdminConfig} from "../admin/server/utils/config"
import {adminObjectId, taskView, updateSubscription, updateTask, userView} from "../admin/server/utils/management"
import security from "../admin/server/middleware/security"
import type {SyncTaskDocument, UserDocument} from "../shared/types/domain"

const globals = globalThis as Record<string, unknown>
globals.createError = createError
const savedEnv = {...process.env}
const restorers: Array<() => void> = []
afterEach(() => {
    for (const restore of restorers.splice(0).reverse()) restore()
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
    clearServerConfigCache()
})

const user: UserDocument = {_id: new ObjectId(), displayName: "Listener", email: "listener@example.com", tier: "pro", createdAt: new Date(), updatedAt: new Date(), creemCustomerId: "cus_1", creemSubscriptionId: "sub_1"}
const task: SyncTaskDocument = {
    _id: new ObjectId(),
    userId: user._id!,
    mode: "playlist",
    direction: "one-way",
    source: {providerAccountId: new ObjectId(), playlistId: "source", name: "Source"},
    destination: {providerAccountId: new ObjectId(), playlistId: "destination", name: "Destination"},
    status: "active",
    nextRunAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
}

/** Mount the real access middleware with a harmless endpoint for boundary tests. */
function protectedRequest() {
    const app = createApp({onError: () => undefined})
    app.use(security)
    app.use(defineEventHandler(() => ({ok: true})))
    return toWebHandler(app)
}

describe("admin access boundary", () => {
    test("requires a verified, allowlisted Google email and secure production origin", () => {
        const config = parseAdminConfig({PLS_ADMIN_ALLOWED_EMAILS: " Igor@ramadas.net ", NODE_ENV: "production"})
        expect(config.url).toBe("https://admin.playlistsyncer.com")
        expect(isAllowedAdmin("IGOR@RAMADAS.NET", true, config)).toBe(true)
        expect(isAllowedAdmin("igor@ramadas.net", false, config)).toBe(false)
        expect(isAllowedAdmin("other@example.com", true, config)).toBe(false)
        expect(isAllowedAdmin("igor@ramadas.net", true, parseAdminConfig({}))).toBe(false)
        expect(() => parseAdminConfig({NODE_ENV: "production", PLS_ADMIN_URL: "http://admin.example.com"})).toThrow()
        expect(() => parseAdminConfig({PLS_ADMIN_SESSION_HOURS: "1000"})).toThrow()
    })

    test("all management APIs deny anonymous requests without opening the database", async () => {
        const db = spyOn(database, "getDatabase").mockRejectedValue(new Error("Must not connect"))
        restorers.push(() => db.mockRestore())
        for (const path of ["users", "tasks", "stats", "users/123/subscription", "subscriptions/discover"]) {
            const response = await protectedRequest()(new Request(`http://localhost:3009/api/${path}`))
            expect(response.status).toBe(401)
            expect(response.headers.get("cache-control")).toBe("no-store")
        }
        expect(db).not.toHaveBeenCalled()
    })

    test("a consumer cookie is not an admin session", async () => {
        const response = await protectedRequest()(new Request("http://localhost:3009/api/users", {headers: {cookie: "ps_session=consumer"}}))
        expect(response.status).toBe(401)
    })

    test("cross-origin and missing-origin mutations fail before database access", async () => {
        for (const origin of [undefined, "https://evil.example", "null"]) {
            const response = await protectedRequest()(new Request("http://localhost:3009/api/tasks/123/cancel", {method: "POST", headers: origin ? {origin} : {}}))
            expect(response.status).toBe(403)
        }
    })

    test("expired sessions and removal from the settings allowlist revoke access", async () => {
        process.env.PLS_ADMIN_ALLOWED_EMAILS = "igor@ramadas.net"
        let session: {email: string; name: string} | null = {email: "other@example.com", name: "Other"}
        let filter: Record<string, unknown> = {}
        const db = spyOn(database, "getDatabase").mockResolvedValue({
            collection: () => ({
                findOne: async (query: Record<string, unknown>) => {
                    filter = query
                    return session
                }
            })
        } as never)
        restorers.push(() => db.mockRestore())
        const request = () => protectedRequest()(new Request("http://localhost:3009/api/stats", {headers: {cookie: "pls_admin=opaque"}}))
        expect((await request()).status).toBe(401)
        session = {email: "igor@ramadas.net", name: "Igor"}
        expect((await request()).status).toBe(200)
        expect(filter).toHaveProperty("expiresAt.$gt")
        session = null
        expect((await request()).status).toBe(401)
        expect(adminConfig().allowedEmails).toEqual(["igor@ramadas.net"])
    })
})

describe("privileged admin mutations", () => {
    test("DTOs exclude verification secrets and task lease IDs", () => {
        expect(userView({...user, emailVerificationTokenHash: "secret"})).not.toHaveProperty("emailVerificationTokenHash")
        expect(taskView({...task, leaseId: "secret"})).not.toHaveProperty("leaseId")
        expect(() => adminObjectId("invalid")).toThrow()
    })

    test("a busy task cannot be canceled or edited", async () => {
        const db = spyOn(data, "collections").mockResolvedValue({syncTasks: {findOne: async () => task}} as never)
        const idle = spyOn(activity, "assertSyncTaskIdle").mockRejectedValue(createError({statusCode: 409}))
        restorers.push(
            () => db.mockRestore(),
            () => idle.mockRestore()
        )
        await expect(updateTask({} as never, task._id!.toHexString(), null, true)).rejects.toMatchObject({statusCode: 409})
    })

    test("direction changes cannot claim another task's writable playlist", async () => {
        const other = {...task, _id: new ObjectId(), destination: task.source}
        const db = spyOn(data, "collections").mockResolvedValue({syncTasks: {findOne: async () => task, find: () => ({toArray: async () => [task, other]})}, users: {findOne: async () => user}} as never)
        const idle = spyOn(activity, "assertSyncTaskIdle").mockResolvedValue(undefined)
        restorers.push(
            () => db.mockRestore(),
            () => idle.mockRestore()
        )
        await expect(updateTask({} as never, task._id!.toHexString(), {status: "active", direction: "two-way", nextRunAt: new Date().toISOString()})).rejects.toMatchObject({statusCode: 409})
    })

    test("subscription actions reject mismatched Creem ownership before any billing write", async () => {
        process.env.PLS_CREEM_PRO_PRODUCT_ID = "prod_pro"
        clearServerConfigCache()
        const db = spyOn(data, "collections").mockResolvedValue({users: {findOne: async () => user}} as never)
        const audit = spyOn(database, "getDatabase").mockResolvedValue({collection: () => ({insertOne: async () => ({insertedId: new ObjectId()}), updateOne: async () => ({})})} as never)
        let paused = false
        const client = spyOn(billing, "getCreem").mockReturnValue({
            subscriptions: {
                get: async () => ({customer: "cus_other", product: "prod_pro"}),
                pause: async () => {
                    paused = true
                }
            }
        } as never)
        restorers.push(
            () => db.mockRestore(),
            () => audit.mockRestore(),
            () => client.mockRestore()
        )
        await expect(updateSubscription({context: {admin: {email: "igor@ramadas.net"}}} as never, user._id!.toHexString(), {action: "pause"})).rejects.toMatchObject({statusCode: 409})
        expect(paused).toBe(false)
    })
})
