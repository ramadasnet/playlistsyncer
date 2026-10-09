import {createServer} from "node:http"
import type {AddressInfo} from "node:net"
import {createError, toNodeListener} from "h3"
import {afterAll, describe, expect, spyOn, test} from "bun:test"

process.env.PLS_SCHEDULER_SECRET = "scheduler-test-secret"

const globals = globalThis as typeof globalThis & {createError: typeof createError}
globals.createError = createError

const {clearServerConfigCache} = await import("../server/utils/config")
clearServerConfigCache()

const {createJobsApp} = await import("../server/jobs/app")
const {resolveJobsPort} = await import("../server/jobs/start")
const {drainSyncRuns, resetShutdownState} = await import("../server/utils/shutdown")
const {default: logger} = await import("../server/utils/logger")

const server = createServer(toNodeListener(createJobsApp()))
const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

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
})
