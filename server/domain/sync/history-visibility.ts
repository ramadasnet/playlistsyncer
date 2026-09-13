// Control which synchronization history is visible at each account tier.
import {resolvedTaskDirection, type AccountTier, type SyncRunDocument, type SyncTaskDocument} from "../../../shared/types/domain"

export type LatestRunSummary = Pick<SyncRunDocument, "status" | "additions" | "removals" | "conflicts" | "skipped" | "startedAt">

// Only paid accounts can inspect detailed synchronization history.
export function canViewRunHistory(tier: AccountTier): boolean {
    return tier === "pro"
}

// Serialize a sync task and hide its latest run for free accounts.
export function serializeSyncTask(task: SyncTaskDocument, latestRun: LatestRunSummary | undefined, tier: AccountTier, entitlementLocked = false) {
    return {
        id: task._id?.toHexString(),
        mode: task.mode || "playlist",
        direction: resolvedTaskDirection(task),
        source: task.source,
        destination: task.destination,
        status: task.status,
        pauseReason: task.pauseReason,
        entitlementLocked,
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastSuccessAt: task.lastSuccessAt,
        lastError: task.lastError,
        latestRun: canViewRunHistory(tier) ? latestRun : undefined
    }
}
