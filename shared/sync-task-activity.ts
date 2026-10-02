// Shared busy check so the task list and the API refuse the same in-progress syncs.

export const syncLeaseDurationMs = 15 * 60 * 1000
export const syncTaskBusyMessage = "This sync task is still running"

// Read a stored timestamp whether the API sent a string or Mongo returned a Date.
function timestamp(value: unknown) {
    if (value instanceof Date) return value.getTime()
    if (typeof value === "number") return value
    if (typeof value === "string" && value) {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : Number.NaN
    }
    return Number.NaN
}

// True while a sync still holds an unexpired task lease.
export function leaseIsActive(expiresAt: unknown, now = Date.now()) {
    const expires = timestamp(expiresAt)
    return Number.isFinite(expires) && expires > now
}

// A running row only blocks actions while it is younger than the sync lease.
export function runningRunIsCurrent(latestRun: {status?: string | null; startedAt?: unknown} | null | undefined, now = Date.now()) {
    if (latestRun?.status !== "running") return false
    const started = timestamp(latestRun.startedAt)
    return Number.isFinite(started) && started + syncLeaseDurationMs > now
}

// True when a lease is live or the latest run is still inside the lease window.
export function isSyncInProgress(task: {leaseExpiresAt?: unknown; latestRun?: {status?: string | null; startedAt?: unknown} | null}, now = Date.now()) {
    return leaseIsActive(task.leaseExpiresAt, now) || runningRunIsCurrent(task.latestRun, now)
}

// Active tasks that never finished a run have not recorded a first result yet.
export function isInitialSyncPending(task: {status?: string | null; lastRunAt?: unknown}) {
    return task.status === "active" && !task.lastRunAt
}

// Keep polling a new task only while its first sync could still be starting.
export function isAwaitingFirstSync(task: {status?: string | null; lastRunAt?: unknown; createdAt?: unknown}, now = Date.now()) {
    if (!isInitialSyncPending(task)) return false
    const created = timestamp(task.createdAt)
    return Number.isFinite(created) && created + syncLeaseDurationMs > now
}
