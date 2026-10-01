// Shared busy check so the task list and the API refuse the same in-progress syncs.

export const syncTaskBusyMessage = "This sync task is still running"

// Active tasks that never finished a run are still processing their first sync.
export function isInitialSyncPending(task: {status?: string | null; lastRunAt?: unknown}) {
    return task.status === "active" && !task.lastRunAt
}

// True when the latest run is in progress or the first sync has not finished.
export function isSyncInProgress(task: {status?: string | null; lastRunAt?: unknown; latestRun?: {status?: string | null} | null}) {
    return task.latestRun?.status === "running" || isInitialSyncPending(task)
}
