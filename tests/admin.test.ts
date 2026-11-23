import {afterEach, describe, expect, spyOn, test} from "bun:test"
import {createHash, randomUUID} from "node:crypto"
import {createApp, createError, createRouter, defineEventHandler, toWebHandler} from "h3"
import {MongoClient, ObjectId} from "mongodb"
import * as database from "../server/utils/database"
import * as data from "../server/data/collections"
import * as accounts from "../server/domain/accounts"
import * as activity from "../server/domain/sync/task-activity"
import {clearServerConfigCache, getEnvironmentConfig, getServerConfig} from "../server/utils/config"
import {mergeRuntimeSettings, readRuntimeSettings, watchRuntimeSettings} from "../server/utils/runtime-settings"
import managementRoute from "../admin/server/api/[...path]"
import {adminConfig, isAllowedAdmin, parseAdminConfig} from "../admin/server/utils/config"
import {adminObjectId, deleteTask, deleteUser, taskView, updateTask, userView} from "../admin/server/utils/management"
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

const user: UserDocument = {_id: new ObjectId(), displayName: "Listener", email: "listener@example.com", createdAt: new Date(), updatedAt: new Date()}
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
        for (const path of ["users", "tasks", "stats", "settings"]) {
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

    test("deleting an idle user reuses the consumer account deletion flow", async () => {
        const db = spyOn(data, "collections").mockResolvedValue({users: {findOne: async () => user}} as never)
        const remove = spyOn(accounts, "deleteUserAccount").mockResolvedValue(undefined)
        const audit = spyOn(database, "getDatabase").mockResolvedValue({collection: () => ({insertOne: async () => ({insertedId: new ObjectId()}), updateOne: async () => ({})})} as never)
        restorers.push(
            () => db.mockRestore(),
            () => remove.mockRestore(),
            () => audit.mockRestore()
        )
        await expect(deleteUser({context: {admin: {email: "igor@ramadas.net"}}} as never, user._id!.toHexString())).resolves.toEqual({ok: true})
        expect(remove).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledWith(user)
    })

    test("a busy task cannot be deleted", async () => {
        let deleted = false
        const db = spyOn(data, "collections").mockResolvedValue({
            syncTasks: {
                findOne: async () => task,
                deleteOne: async () => {
                    deleted = true
                    return {deletedCount: 1}
                }
            }
        } as never)
        const idle = spyOn(activity, "assertSyncTaskIdle").mockRejectedValue(createError({statusCode: 409}))
        restorers.push(
            () => db.mockRestore(),
            () => idle.mockRestore()
        )
        await expect(deleteTask({} as never, task._id!.toHexString())).rejects.toMatchObject({statusCode: 409})
        expect(deleted).toBe(false)
    })

    test("deleting an idle task removes it with its runs and snapshots", async () => {
        const deletions: unknown[] = []
        const history: unknown[] = []
        const db = spyOn(data, "collections").mockResolvedValue({
            syncTasks: {
                findOne: async () => task,
                deleteOne: async (filter: unknown) => {
                    deletions.push(filter)
                    return {deletedCount: 1}
                }
            },
            syncSnapshots: {
                deleteMany: async (filter: unknown) => {
                    history.push(filter)
                    return {deletedCount: 1}
                }
            },
            syncRuns: {
                deleteMany: async (filter: unknown) => {
                    history.push(filter)
                    return {deletedCount: 1}
                }
            }
        } as never)
        const idle = spyOn(activity, "assertSyncTaskIdle").mockResolvedValue(undefined)
        const audit = spyOn(database, "getDatabase").mockResolvedValue({collection: () => ({insertOne: async () => ({insertedId: new ObjectId()}), updateOne: async () => ({})})} as never)
        restorers.push(
            () => db.mockRestore(),
            () => idle.mockRestore(),
            () => audit.mockRestore()
        )
        await expect(deleteTask({context: {admin: {email: "igor@ramadas.net"}}} as never, task._id!.toHexString())).resolves.toEqual({ok: true})
        expect(deletions).toHaveLength(1)
        expect(history).toEqual([{taskId: task._id}, {taskId: task._id}])
    })
})

describe("application settings", () => {
    test("merges stored values over deployment defaults and validates the result", () => {
        const environment = {...getEnvironmentConfig(), smtpHost: "smtp.deployment.example", smtpPassword: "deployment-password", safeMode: "true"}
        const config = mergeRuntimeSettings({smtpHost: "smtp.infisical.example", smtpPassword: "", safeMode: "false"}, environment)
        expect(config.smtpHost).toBe("smtp.infisical.example")
        expect(config.smtpPassword).toBeUndefined()
        expect(config.safeMode).toBe(false)
        expect(mergeRuntimeSettings({}, environment).smtpPassword).toBe("deployment-password")
        expect(() => mergeRuntimeSettings({smtpPort: "-1"}, environment)).toThrow("Invalid application settings")
    })

    test.skipIf(!savedEnv.PLS_MONGODB_URI)("authenticates, writes changed settings to Infisical, masks secrets, audits edits, and refreshes", async () => {
        process.env.PLS_ADMIN_ALLOWED_EMAILS = "igor@example.test"
        process.env.PLS_ADMIN_URL = "http://localhost:3009"
        process.env.PLS_TOKEN_ENCRYPTION_KEY = "settings-test-key"
        process.env.PLS_SMTP_PASSWORD = "deployment-password"
        process.env.PLS_SMTP_HOST = "smtp.deployment.example"
        process.env.PLS_SMTP_USER = "deployment-user"
        process.env.PLS_INFISICAL_CLIENT_ID = "test-identity"
        process.env.PLS_INFISICAL_CLIENT_SECRET = "test-identity-secret"
        process.env.PLS_INFISICAL_PROJECT_ID = "test-project"
        const secrets = new Map<string, string>()
        const writes: unknown[] = []
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname
            if (path === "/api/v1/auth/universal-auth/login") return Response.json({accessToken: "test-token"})
            if (path === "/api/v4/secrets") return Response.json({secrets: [...secrets].map(([secretKey, secretValue]) => ({secretKey, secretValue}))})
            if (path === "/api/v4/secrets/batch" && init?.method === "PATCH") {
                const body = JSON.parse(String(init.body))
                writes.push(body)
                for (const {secretKey, secretValue} of body.secrets) secrets.set(secretKey, secretValue)
                return Response.json({})
            }
            throw new Error("Unexpected Infisical request")
        })
        restorers.push(() => fetchSpy.mockRestore())
        const client = new MongoClient(savedEnv.PLS_MONGODB_URI!)
        const db = client.db(`pls_settings_test_${randomUUID()}`)
        const databaseSpy = spyOn(database, "getDatabase").mockResolvedValue(db)
        restorers.push(() => databaseSpy.mockRestore())
        const cookie = "pls_admin=settings-test-session"
        const app = createApp({onError: () => undefined})
        const router = createRouter()
        router.use("/api/**:path", managementRoute)
        app.use(security)
        app.use(router.handler)
        const handle = toWebHandler(app)
        const url = "http://localhost:3009/api/settings"
        const patch = (revision: string | null, changes: Record<string, string | null>, origin = "http://localhost:3009") =>
            handle(new Request(url, {method: "PATCH", headers: {cookie, origin, "content-type": "application/json"}, body: JSON.stringify({revision, changes})}))
        try {
            await db.collection("adminSessions").insertOne({
                email: "igor@example.test",
                name: "Igor",
                tokenHash: createHash("sha256").update("settings-test-session").digest("hex"),
                expiresAt: new Date(Date.now() + 60_000)
            })
            expect((await handle(new Request(url))).status).toBe(401)
            const response = await handle(new Request(url, {headers: {cookie}}))
            expect(response.status).toBe(200)
            expect(response.headers.get("cache-control")).toBe("no-store")
            const text = await response.text()
            expect(text).not.toContain("deployment-password")
            expect(text).not.toContain("settings-test-key")
            const initial = JSON.parse(text)
            expect(initial.revision).toBeNull()
            expect(initial.groups.flatMap((group: {fields: unknown[]}) => group.fields)).toContainEqual(expect.objectContaining({name: "smtpPassword", value: null, stored: false, configured: true}))
            const initialSettings = watchRuntimeSettings()
            try {
                await initialSettings.ready
                expect(getServerConfig().smtpHost).toBe("smtp.deployment.example")
                expect(writes).toEqual([])
            } finally {
                initialSettings.stop()
            }
            expect((await patch(initial.revision, {smtpPort: "587"}, "https://other.example")).status).toBe(403)
            expect((await patch(initial.revision, {tokenEncryptionKey: "bad-key"})).status).toBe(400)
            expect((await patch(initial.revision, {smtpPort: "-1"})).status).toBe(400)

            const overrides = {smtpPassword: "new-password", smtpPort: "587", smtpHost: "smtp.infisical.example"}
            const firstEdits = await Promise.all([patch(initial.revision, overrides), patch(initial.revision, overrides)])
            expect(firstEdits.map(({status}) => status).sort()).toEqual([200, 409])
            const updated = firstEdits.find(({ok}) => ok)!
            expect(updated.status).toBe(200)
            const updatedText = await updated.text()
            expect(updatedText).not.toContain("new-password")
            expect(JSON.parse(updatedText).groups.find(({label}: {label: string}) => label === "SMTP").fields).toContainEqual(expect.objectContaining({name: "smtpPassword", value: null, stored: true, configured: true}))
            expect((await patch(initial.revision, {smtpPort: "465"})).status).toBe(409)
            expect(writes).toEqual([
                {
                    projectId: "test-project",
                    environment: "prod",
                    secretPath: "/",
                    mode: "upsert",
                    secrets: [
                        {secretKey: "PLS_SMTP_PASSWORD", secretValue: "new-password"},
                        {secretKey: "PLS_SMTP_PORT", secretValue: "587"},
                        {secretKey: "PLS_SMTP_HOST", secretValue: "smtp.infisical.example"}
                    ]
                }
            ])
            expect((await readRuntimeSettings()).values).toEqual(overrides)
            const audit = await db.collection("adminAudit").findOne({action: "settings.update", status: "succeeded"})
            expect(audit?.details).toEqual({fields: ["smtpPassword", "smtpPort", "smtpHost"]})
            expect(audit?.actor).toBe("igor@example.test")
            expect(JSON.stringify(audit)).not.toContain("new-password")

            secrets.set("PLS_SMTP_USER", "infisical-user")
            secrets.set("PLS_TOKEN_ENCRYPTION_KEY", "not-reloaded")
            clearServerConfigCache()
            expect(getServerConfig().smtpHost).toBe("smtp.deployment.example")
            const settings = watchRuntimeSettings()
            try {
                await settings.ready
                expect(getServerConfig()).toMatchObject({smtpHost: "smtp.infisical.example", smtpPort: 587, smtpPassword: "new-password", smtpUser: "infisical-user", tokenEncryptionKey: "settings-test-key"})
            } finally {
                settings.stop()
            }
            expect((await patch(JSON.parse(updatedText).revision, {smtpHost: "another.example"})).status).toBe(409)
            const {revision} = await readRuntimeSettings()
            const cleared = await patch(revision, {smtpPassword: ""})
            expect(cleared.status).toBe(200)
            expect(secrets.get("PLS_SMTP_PASSWORD")).toBe("")
            expect(getServerConfig().smtpPassword).toBeUndefined()

            secrets.delete("PLS_SMTP_HOST")
            const afterDeletion = watchRuntimeSettings()
            try {
                await afterDeletion.ready
                expect(getServerConfig().smtpHost).toBe("smtp.deployment.example")
            } finally {
                afterDeletion.stop()
            }
        } finally {
            await db.dropDatabase()
            await client.close()
        }
    })
})
