// Reusable reverse-sync plans. Each case picks a direction, a cadence, and a reason.
import type {SyncRunStatus} from "./types/domain"

export const reverseSyncDirections = ["forward", "reverse"] as const
export type ReverseSyncDirection = (typeof reverseSyncDirections)[number]

export const reverseSyncCadences = ["one-time", "ongoing"] as const
export type ReverseSyncCadence = (typeof reverseSyncCadences)[number]

// Add a reason here when another special case should use the same path.
export const reverseSyncReasons = ["deleted-source"] as const
export type ReverseSyncReason = (typeof reverseSyncReasons)[number]

// Run failures that can offer a reverse sync. A deleted source playlist is the first one.
export type SyncFailureReason = ReverseSyncReason

// What a caller asks the shared reverse-sync path to do.
export interface ReverseSyncRequest {
    direction: ReverseSyncDirection
    cadence: ReverseSyncCadence
    reason: ReverseSyncReason
}

// Server-side case. recreateTarget repairs a playlist the provider no longer has.
export interface ReverseSyncCase extends ReverseSyncRequest {
    recreateTarget: boolean
}

export const reverseSyncCases: Record<ReverseSyncReason, ReverseSyncCase> = {
    "deleted-source": {
        direction: "reverse",
        cadence: "one-time",
        reason: "deleted-source",
        recreateTarget: true
    }
}

// Return the registered case when the request uses that case's direction and cadence.
export function reverseSyncCaseFor(request: ReverseSyncRequest): ReverseSyncCase | undefined {
    const syncCase = reverseSyncCases[request.reason]
    if (!syncCase || syncCase.direction !== request.direction || syncCase.cadence !== request.cadence) {
        return undefined
    }
    return syncCase
}

// Public plan for a reason, without server-only flags.
export function reverseSyncRequestFor(reason: ReverseSyncReason): ReverseSyncRequest {
    const syncCase = reverseSyncCases[reason]
    return {direction: syncCase.direction, cadence: syncCase.cadence, reason: syncCase.reason}
}

export interface ReverseSyncRunState {
    status: SyncRunStatus
    failureReason?: SyncFailureReason
    reverseSync?: ReverseSyncRequest
}

// True only for a reason registered on the case object itself, not one inherited from Object.
export function isReverseSyncReason(value: unknown): value is ReverseSyncReason {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(reverseSyncCases, value)
}

// Read a deleted-source marker attached to a provider failure.
export function readSyncFailureReason(error: unknown): SyncFailureReason | undefined {
    if (!error || typeof error !== "object") {
        return undefined
    }
    const reason = (error as {data?: {failureReason?: unknown}}).data?.failureReason
    return isReverseSyncReason(reason) ? reason : undefined
}

// Offer the registered plan when this failed run is still the case it recorded.
export function availableReverseSync(run: ReverseSyncRunState, newerRuns: readonly ReverseSyncRunState[] = []): ReverseSyncRequest | undefined {
    if (run.status !== "failed" || !isReverseSyncReason(run.failureReason)) {
        return undefined
    }
    const syncCase = reverseSyncCases[run.failureReason]
    // A later completed run read the source playlist again, so the restore no longer applies.
    const superseded = newerRuns.some((newer) => newer.status === "succeeded" || newer.status === "partial")
    if (superseded) {
        return undefined
    }
    return reverseSyncRequestFor(syncCase.reason)
}

// Note shown when a source restore leaves the running state. A partial run still has unmatched tracks.
export function finishedRestoreMessage(status: SyncRunStatus): string {
    if (status === "succeeded") {
        return "The source playlist was restored from the target. Later syncs keep their usual direction."
    }
    if (status === "partial") {
        return "The source playlist was restored, but some tracks remain unmatched. Later syncs keep their usual direction."
    }
    return ""
}
