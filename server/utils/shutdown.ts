// Let a stopping process finish its own in-flight sync runs, then mark the unfinished ones failed.
import type {ObjectId} from "mongodb"
import {setTimeout as sleep} from "node:timers/promises"
import {collections} from "../data/collections"
import logger from "./logger"

export const interruptedRunMessage = "The server stopped before this run finished"

const inFlightRuns = new Map<ObjectId, Promise<unknown>>()
let stopping = false

// Whether this process is shutting down and must not start new work.
export function isShuttingDown(): boolean {
    return stopping
}

// Remember a started run until it settles, so shutdown can wait for it.
export function trackSyncRun<T>(runId: ObjectId, run: Promise<T>): Promise<T> {
    inFlightRuns.set(runId, run)
    run.then(
        () => inFlightRuns.delete(runId),
        () => inFlightRuns.delete(runId)
    )
    return run
}

// Mark runs that are still running as failed. Their task lease is left for the sync engine to expire.
async function failInterruptedRuns(runIds: ObjectId[]): Promise<number> {
    const db = await collections()
    const result = await db.syncRuns.updateMany({_id: {$in: runIds}, status: "running"}, {$set: {status: "failed", error: interruptedRunMessage, finishedAt: new Date()}, $unset: {progress: ""}})
    return result.modifiedCount
}

/**
 * Stops new work, waits for this process's tracked runs, and fails the ones still going at the deadline.
 * @param timeoutMs How long to wait for in-flight runs.
 * @param failRuns Persists the failure of runs that did not finish in time.
 */
export async function drainSyncRuns(timeoutMs: number, failRuns = failInterruptedRuns): Promise<void> {
    stopping = true
    const deadline = Date.now() + timeoutMs
    if (inFlightRuns.size) {
        logger.info("Shutdown.drain", `Waiting up to ${timeoutMs}ms for ${inFlightRuns.size} sync run(s)`)
    }
    // Loop because a run accepted just before shutdown can register while we wait.
    while (inFlightRuns.size && Date.now() < deadline) {
        await Promise.race([Promise.allSettled(inFlightRuns.values()), sleep(deadline - Date.now(), undefined, {ref: false})])
    }
    if (!inFlightRuns.size) {
        return
    }
    const runIds = [...inFlightRuns.keys()]
    try {
        const failed = await failRuns(runIds)
        logger.warn("Shutdown.drain", `Marked ${failed} unfinished sync run(s) failed`, runIds.map((id) => id.toHexString()).join(", "))
    } catch (error) {
        logger.error("Shutdown.drain", error, "Could not mark unfinished sync runs failed")
    }
}

// Forget shutdown state so tests in the same process start clean.
export function resetShutdownState(): void {
    stopping = false
    inFlightRuns.clear()
}
