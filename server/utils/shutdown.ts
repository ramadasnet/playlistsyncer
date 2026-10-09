// Let a stopping process finish its own in-flight sync runs, then mark the unfinished ones failed.
import {createError} from "h3"
import type {ObjectId} from "mongodb"
import {setTimeout as sleep} from "node:timers/promises"
import {collections} from "../data/collections"
import logger from "./logger"

export const interruptedRunMessage = "The server stopped before this run finished"

// Starts whose running row may already exist but whose run ID is not known yet.
const pendingStarts = new Set<Promise<unknown>>()
const inFlightRuns = new Map<ObjectId, Promise<unknown>>()
let stopping = false

// Whether this process is shutting down and must not start new work.
export function isShuttingDown(): boolean {
    return stopping
}

/**
 * Starts a sync run under shutdown tracking, from before its running row is written until the run settles.
 * @param begin Acquires the lease and inserts the running row.
 * @param complete Executes the started run.
 * @returns The started context, and the run's completion for the caller to await or hand to waitUntil.
 */
export async function startTrackedSyncRun<C extends {runId: ObjectId}, T>(begin: () => Promise<C>, complete: (context: C) => Promise<T>): Promise<{context: C; finished: Promise<T>}> {
    if (stopping) {
        throw createError({statusCode: 503, statusMessage: "Server is shutting down"})
    }
    const starting = begin()
    pendingStarts.add(starting)
    try {
        const context = await starting
        const finished = complete(context)
        inFlightRuns.set(context.runId, finished)
        finished.then(
            () => inFlightRuns.delete(context.runId),
            () => inFlightRuns.delete(context.runId)
        )
        return {context, finished}
    } finally {
        // Removed in the same turn the run is registered, so a drain always sees the start or the run.
        pendingStarts.delete(starting)
    }
}

// Mark runs that are still running as failed. Their task lease is left for the sync engine to expire.
async function failInterruptedRuns(runIds: ObjectId[], timeoutMs: number): Promise<number> {
    const db = await collections()
    const result = await db.syncRuns.updateMany({_id: {$in: runIds}, status: "running"}, {$set: {status: "failed", error: interruptedRunMessage, finishedAt: new Date()}, $unset: {progress: ""}}, {timeoutMS: timeoutMs})
    return result.modifiedCount
}

/**
 * Stops new work, waits for this process's starting and running syncs, and fails the runs still going at the deadline.
 * @param timeoutMs Total budget, including the final write that marks unfinished runs failed.
 * @param failRuns Persists the failure of runs that did not finish in time, within the given milliseconds.
 */
export async function drainSyncRuns(timeoutMs: number, failRuns = failInterruptedRuns): Promise<void> {
    stopping = true
    // Keep a slice of the budget for the failure write, so the whole drain ends inside the container's grace period.
    const writeBudgetMs = Math.min(2000, Math.floor(timeoutMs / 4))
    const waitDeadline = Date.now() + timeoutMs - writeBudgetMs
    const pending = () => pendingStarts.size + inFlightRuns.size
    if (pending()) {
        logger.info("Shutdown.drain", `Waiting up to ${timeoutMs - writeBudgetMs}ms for ${pending()} sync run(s)`)
    }
    // Loop because a start that resolves while we wait registers its run.
    while (pending() && Date.now() < waitDeadline) {
        await Promise.race([Promise.allSettled([...pendingStarts, ...inFlightRuns.values()]), sleep(waitDeadline - Date.now(), undefined, {ref: false})])
    }
    if (pendingStarts.size) {
        logger.warn("Shutdown.drain", `${pendingStarts.size} sync run(s) were still starting; their run IDs are unknown`)
    }
    if (!inFlightRuns.size) {
        return
    }
    const runIds = [...inFlightRuns.keys()]
    const runList = runIds.map((id) => id.toHexString()).join(", ")
    try {
        const failed = await Promise.race([failRuns(runIds, writeBudgetMs), sleep(writeBudgetMs, "timeout" as const, {ref: false})])
        if (failed === "timeout") {
            logger.error("Shutdown.drain", `Marking unfinished sync runs failed timed out after ${writeBudgetMs}ms`, runList)
        } else {
            logger.warn("Shutdown.drain", `Marked ${failed} unfinished sync run(s) failed`, runList)
        }
    } catch (error) {
        logger.error("Shutdown.drain", error, "Could not mark unfinished sync runs failed", runList)
    }
}

// Forget shutdown state so tests in the same process start clean.
export function resetShutdownState(): void {
    stopping = false
    pendingStarts.clear()
    inFlightRuns.clear()
}
