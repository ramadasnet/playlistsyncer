import {afterEach, describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {drainSyncRuns, isShuttingDown, resetShutdownState, trackSyncRun} from "../server/utils/shutdown"

// A run whose completion the test controls.
function controlledRun() {
    let finish!: () => void
    let fail!: (error: Error) => void
    const run = new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
    })
    return {run, finish, fail}
}

afterEach(() => resetShutdownState())

describe("shutdown drain", () => {
    test("waits for tracked runs that finish before the deadline", async () => {
        const first = controlledRun()
        const second = controlledRun()
        trackSyncRun(new ObjectId(), first.run)
        trackSyncRun(new ObjectId(), second.run).catch(() => undefined)
        const failed: ObjectId[][] = []
        setTimeout(() => first.finish(), 20)
        setTimeout(() => second.fail(new Error("provider error")), 40)

        const started = Date.now()
        await drainSyncRuns(2000, async (runIds) => {
            failed.push(runIds)
            return runIds.length
        })

        expect(isShuttingDown()).toBe(true)
        expect(Date.now() - started).toBeLessThan(1000)
        expect(failed).toEqual([])
    })

    test("marks only the runs still going at the deadline as failed", async () => {
        const finished = controlledRun()
        const stuck = controlledRun()
        const finishedId = new ObjectId()
        const stuckId = new ObjectId()
        trackSyncRun(finishedId, finished.run)
        trackSyncRun(stuckId, stuck.run)
        finished.finish()
        const failed: ObjectId[][] = []

        await drainSyncRuns(50, async (runIds) => {
            failed.push(runIds)
            return runIds.length
        })

        expect(failed).toEqual([[stuckId]])
    })

    test("waits for a run that registers while draining", async () => {
        const late = controlledRun()
        const failed: ObjectId[][] = []
        const early = controlledRun()
        trackSyncRun(new ObjectId(), early.run)
        setTimeout(() => {
            trackSyncRun(new ObjectId(), late.run)
            early.finish()
        }, 10)
        setTimeout(() => late.finish(), 40)

        await drainSyncRuns(2000, async (runIds) => {
            failed.push(runIds)
            return runIds.length
        })

        expect(failed).toEqual([])
    })

    test("finishes shutdown even when the failure cannot be saved", async () => {
        trackSyncRun(new ObjectId(), controlledRun().run)

        await drainSyncRuns(10, async () => {
            throw new Error("database unavailable")
        })

        expect(isShuttingDown()).toBe(true)
    })
})
