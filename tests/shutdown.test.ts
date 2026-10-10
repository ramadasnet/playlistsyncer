import {afterEach, describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {drainSyncRuns, isShuttingDown, resetShutdownState, startTrackedSyncRun} from "../server/utils/shutdown"

// A promise whose settlement the test controls.
function controlled<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return {promise, resolve, reject}
}

// Start a tracked run whose begin resolves at once and whose completion the test controls.
async function startRun(runId = new ObjectId()) {
    const run = controlled()
    const started = await startTrackedSyncRun(
        async () => ({runId}),
        () => run.promise
    )
    started.finished.catch(() => undefined)
    return {runId, ...run}
}

// Record the run IDs a drain marks failed.
function recordFailures() {
    const failed: ObjectId[][] = []
    return {
        failed,
        failRuns: async (runIds: ObjectId[]) => {
            failed.push(runIds)
            return runIds.length
        }
    }
}

afterEach(() => resetShutdownState())

describe("shutdown drain", () => {
    test("waits for tracked runs that finish before the deadline", async () => {
        const first = await startRun()
        const second = await startRun()
        const {failed, failRuns} = recordFailures()
        setTimeout(() => first.resolve(), 20)
        setTimeout(() => second.reject(new Error("provider error")), 40)

        const started = Date.now()
        await drainSyncRuns(2000, failRuns)

        expect(isShuttingDown()).toBe(true)
        expect(Date.now() - started).toBeLessThan(1000)
        expect(failed).toEqual([])
    })

    test("marks only the runs still going at the deadline as failed", async () => {
        const finished = await startRun()
        const stuck = await startRun()
        finished.resolve()
        const {failed, failRuns} = recordFailures()

        await drainSyncRuns(50, failRuns)

        expect(failed).toEqual([[stuck.runId]])
    })

    test("waits for a run whose start is still writing its running row", async () => {
        const begin = controlled<{runId: ObjectId}>()
        const runId = new ObjectId()
        const starting = startTrackedSyncRun(
            () => begin.promise,
            () => new Promise(() => undefined)
        )
        const {failed, failRuns} = recordFailures()
        setTimeout(() => begin.resolve({runId}), 20)

        await drainSyncRuns(200, failRuns)

        await starting
        expect(failed).toEqual([[runId]])
    })

    test("refuses to start runs once shutdown has begun", async () => {
        await drainSyncRuns(0)
        let begun = false

        await expect(
            startTrackedSyncRun(
                async () => {
                    begun = true
                    return {runId: new ObjectId()}
                },
                async () => undefined
            )
        ).rejects.toThrow("Server is shutting down")
        expect(begun).toBe(false)
    })

    test("bounds the failure write by the shutdown budget", async () => {
        await startRun()
        let writeBudgetMs = 0

        const started = Date.now()
        await drainSyncRuns(400, (_runIds, budgetMs) => {
            writeBudgetMs = budgetMs
            return new Promise<number>(() => undefined)
        })

        expect(writeBudgetMs).toBe(100)
        expect(Date.now() - started).toBeLessThan(600)
    })

    test("finishes shutdown even when the failure cannot be saved", async () => {
        await startRun()

        await drainSyncRuns(10, async () => {
            throw new Error("database unavailable")
        })

        expect(isShuttingDown()).toBe(true)
    })
})
