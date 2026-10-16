import {createServer, type Server} from "node:http"
import type {AddressInfo} from "node:net"
import {setTimeout as sleep} from "node:timers/promises"
import {createError, toNodeListener} from "h3"
import {afterAll, afterEach, describe, expect, spyOn, test} from "bun:test"

process.env.PLS_SCHEDULER_SECRET = "scheduler-test-secret"

const globals = globalThis as typeof globalThis & {createError: typeof createError}
globals.createError = createError

const {clearServerConfigCache} = await import("../server/utils/config")
clearServerConfigCache()

const {createJobsApp} = await import("../server/jobs/app")
const {resolveJobsPort, shutdownJobsServer} = await import("../server/jobs/start")
const jobRequests = await import("../server/jobs/requests")
const {beginNonSyncRequest, drainNonSyncRequests, resetNonSyncRequests} = jobRequests
const {drainSyncRuns, resetShutdownState} = await import("../server/utils/shutdown")
const {default: logger} = await import("../server/utils/logger")

const server = createServer(toNodeListener(createJobsApp()))
const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
afterEach(() => {
    resetShutdownState()
    resetNonSyncRequests()
})

function listen(target: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        target.once("error", reject)
        target.listen(0, "127.0.0.1", () => resolve())
    })
}

describe("jobs server", () => {
    test("defaults the listener to port 3008 and rejects an invalid port", () => {
        expect(resolveJobsPort(undefined)).toBe(3008)
        expect(resolveJobsPort("")).toBe(3008)
        expect(resolveJobsPort("3010")).toBe(3010)
        expect(() => resolveJobsPort("0")).toThrow("PLS_JOBS_PORT")
        expect(() => resolveJobsPort("nope")).toThrow("PLS_JOBS_PORT")
    })

    test("rejects scheduled calls that do not carry the scheduler secret", async () => {
        const missing = await fetch(`http://127.0.0.1:${port}/api/jobs/sync-due`, {method: "POST"})
        expect(missing.status).toBe(401)
        const subscriptionSync = await fetch(`http://127.0.0.1:${port}/api/jobs/subscription-sync`, {method: "POST"})
        expect(subscriptionSync.status).toBe(401)
        const wrong = await fetch(`http://127.0.0.1:${port}/api/jobs/sync-due`, {
            method: "POST",
            headers: {authorization: "Bearer wrong-secret"}
        })
        expect(wrong.status).toBe(401)
    })

    test("does not serve job routes on GET", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sync-due`)
        expect(response.status).toBe(404)
    })

    test("logs rejected job requests", async () => {
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
        try {
            await fetch(`http://127.0.0.1:${port}/api/jobs/weekly-sync-summary`, {method: "POST", headers: {authorization: "Bearer wrong-secret"}})
            expect(warn).toHaveBeenCalledWith("Jobs.request", "POST /api/jobs/weekly-sync-summary", "Status 401", "Invalid scheduler authorization")
        } finally {
            warn.mockRestore()
        }
    })

    test("refuses new requests once shutdown has started", async () => {
        try {
            await drainSyncRuns(0)
            const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sync-due`, {method: "POST", headers: {authorization: "Bearer scheduler-test-secret"}})
            expect(response.status).toBe(503)
        } finally {
            resetShutdownState()
        }
    })

    test("does not treat sync jobs as non-sync requests", () => {
        expect(beginNonSyncRequest("/api/jobs/sync-due")).toBeUndefined()
        expect(beginNonSyncRequest("/api/jobs/sync-due?retry=1")).toBeUndefined()
        expect(beginNonSyncRequest("/api/jobs/sync-task/abc")).toBeUndefined()
        const finish = beginNonSyncRequest("/api/jobs/weekly-sync-summary?dry=1")
        if (!finish) throw new Error("weekly summary was not tracked")
        finish()
    })

    test("asks to track each accepted request and releases it when the response is sent", async () => {
        const calls: string[] = []
        const begin = spyOn(jobRequests, "beginNonSyncRequest").mockImplementation((path: string) => {
            calls.push(path.split("?")[0])
            return undefined
        })
        try {
            const summary = await fetch(`http://127.0.0.1:${port}/api/jobs/weekly-sync-summary`, {method: "POST", headers: {authorization: "Bearer wrong-secret"}})
            const due = await fetch(`http://127.0.0.1:${port}/api/jobs/sync-due`, {method: "POST", headers: {authorization: "Bearer wrong-secret"}})
            expect(summary.status).toBe(401)
            expect(due.status).toBe(401)
            expect(calls).toEqual(["/api/jobs/weekly-sync-summary", "/api/jobs/sync-due"])
        } finally {
            begin.mockRestore()
        }

        const response = await fetch(`http://127.0.0.1:${port}/api/jobs/weekly-sync-summary`, {method: "POST", headers: {authorization: "Bearer wrong-secret"}})
        expect(response.status).toBe(401)
        const started = Date.now()
        await drainNonSyncRequests(2000)
        expect(Date.now() - started).toBeLessThan(200)
    })

    test("closes the database after an accepted non-sync request finishes", async () => {
        const jobs = createServer((_req, res) => res.end("ok"))
        await listen(jobs)
        const finish = beginNonSyncRequest("/api/jobs/weekly-sync-summary")
        if (!finish) throw new Error("weekly summary was not tracked")
        let closed = false
        const done = shutdownJobsServer(jobs, 2000, async () => {
            closed = true
        })
        await sleep(25)
        expect(closed).toBe(false)
        finish()
        await done
        expect(closed).toBe(true)
    })

    test("closes the database when a non-sync request is still running at the deadline", async () => {
        const jobs = createServer((_req, res) => res.end("ok"))
        await listen(jobs)
        beginNonSyncRequest("/api/jobs/weekly-sync-summary")
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
        try {
            const started = Date.now()
            let closed = false
            await shutdownJobsServer(jobs, 80, async () => {
                closed = true
            })
            expect(closed).toBe(true)
            expect(Date.now() - started).toBeGreaterThanOrEqual(40)
            expect(Date.now() - started).toBeLessThan(500)
            expect(warn).toHaveBeenCalledWith("Jobs.shutdown", expect.stringContaining("non-sync request"))
        } finally {
            warn.mockRestore()
        }
    })
})
