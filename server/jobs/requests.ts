// Track accepted jobs requests that are not sync runs, so shutdown can finish them before closing MongoDB.
import {setTimeout as sleep} from "node:timers/promises"
import logger from "../utils/logger"

const pending = new Set<Promise<void>>()

// Sync handlers await the run, which the sync drain already tracks. Counting them here would wait past the deadline.
function isSyncJobPath(path: string): boolean {
    const query = path.indexOf("?")
    const pathname = query === -1 ? path : path.slice(0, query)
    return pathname === "/api/jobs/sync-due" || pathname.startsWith("/api/jobs/sync-task/")
}

/**
 * Registers one accepted request that is not a sync job.
 * @param path Request path, including a query string when the client sent one.
 * @returns The function that marks the request finished, or undefined for a sync job.
 */
export function beginNonSyncRequest(path: string): (() => void) | undefined {
    if (isSyncJobPath(path)) {
        return undefined
    }
    let settled = false
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
        finish = () => {
            if (settled) return
            settled = true
            resolve()
        }
    })
    pending.add(done)
    done.then(() => pending.delete(done))
    return finish
}

/**
 * Waits for accepted non-sync requests, then returns even if some are still running.
 * @param timeoutMs How long shutdown can wait before closing MongoDB.
 */
export async function drainNonSyncRequests(timeoutMs: number): Promise<void> {
    const budgetMs = Math.max(0, timeoutMs)
    const deadline = Date.now() + budgetMs
    if (pending.size) {
        logger.info("Jobs.shutdown", `Waiting up to ${budgetMs}ms for ${pending.size} non-sync request(s)`)
    }
    while (pending.size && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...pending]), sleep(deadline - Date.now(), undefined, {ref: false})])
    }
    if (pending.size) {
        logger.warn("Jobs.shutdown", `${pending.size} non-sync request(s) still running at the shutdown deadline`)
    }
}

// Forget tracked requests so tests in the same process start clean.
export function resetNonSyncRequests(): void {
    pending.clear()
}
