// Decide whether a requested reverse sync is a registered case that still applies.
import type {SyncRunDocument} from "~~/shared/types/domain"
import {availableReverseSync, reverseSyncCaseFor, type ReverseSyncCase, type ReverseSyncRequest} from "../../../shared/reverse-sync"

// Reject unknown plans and restores whose failed run is no longer the matching case.
export function assertReverseSyncAvailable(runs: Pick<SyncRunDocument, "status" | "failureReason" | "reverseSync" | "startedAt">[], request: ReverseSyncRequest): ReverseSyncCase {
    const syncCase = reverseSyncCaseFor(request)
    if (!syncCase) {
        throw createError({statusCode: 400, statusMessage: "This reverse sync is not available"})
    }
    const ordered = [...runs].sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    const offered = ordered.some((run, index) => {
        const offer = availableReverseSync(run, ordered.slice(0, index))
        return offer?.direction === request.direction && offer.cadence === request.cadence && offer.reason === request.reason
    })
    if (!offered) {
        throw createError({statusCode: 409, statusMessage: "This restore is not available for the sync task"})
    }
    return syncCase
}
