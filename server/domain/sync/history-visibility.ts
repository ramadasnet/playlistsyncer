import {
    resolvedTaskDirection,
    type AccountTier,
    type SyncRunDocument,
    type SyncTaskDocument
} from "../../../shared/types/domain"

export type LatestRunSummary = Pick<
    SyncRunDocument,
    "status" | "additions" | "removals" | "conflicts" | "skipped" | "startedAt"
>

export function canViewRunHistory(tier: AccountTier): boolean {
    return tier === "pro"
}

export function serializeSyncTask(task: SyncTaskDocument, latestRun: LatestRunSummary | undefined, tier: AccountTier) {
    return {
        id: task._id?.toHexString(),
        mode: task.mode || "playlist",
        direction: resolvedTaskDirection(task),
        source: task.source,
        destination: task.destination,
        status: task.status,
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastSuccessAt: task.lastSuccessAt,
        lastError: task.lastError,
        latestRun: canViewRunHistory(tier) ? latestRun : undefined
    }
}
