// Control which synchronization history is visible at each account tier.
import {resolvedTaskDirection, type AccountTier, type CanonicalTrack, type SyncRunDocument, type SyncRunTrackReference, type SyncSnapshotDocument, type SyncTaskDocument} from "../../../shared/types/domain"

export type LatestRunSummary = Pick<SyncRunDocument, "status" | "additions" | "removals" | "conflicts" | "skipped" | "startedAt">

export const proRunHistoryLimit = 50

export interface SerializedRunTrack {
    title: string
    artists: string[]
    playlistName?: string
}

export interface SerializedSyncRun {
    id: string
    trigger: SyncRunDocument["trigger"]
    status: SyncRunDocument["status"]
    additions: number
    removals: number
    conflicts: number
    skipped: number
    startedAt: Date
    finishedAt?: Date
    error?: string
    addedTracks: SerializedRunTrack[]
    removedTracks: SerializedRunTrack[]
    unmatchedTracks: SerializedRunTrack[]
}

// Only paid accounts can browse past synchronization runs.
export function canViewRunHistory(tier: AccountTier): boolean {
    return tier === "pro"
}

// Free accounts get the latest run; PRO accounts can page through recent history.
export function runHistoryLimitFor(tier: AccountTier) {
    return canViewRunHistory(tier) ? proRunHistoryLimit : 1
}

// Public label for a stored run track.
export function serializeRunTrack(track: SyncRunTrackReference): SerializedRunTrack {
    const title = track.title?.trim() || "Unknown track"
    const artists = (track.artists || []).map((artist) => artist.trim()).filter(Boolean)
    const playlistName = track.playlistName?.trim()
    return playlistName ? {title, artists, playlistName} : {title, artists}
}

// Public representation of one synchronization run and its track lists.
export function serializeSyncRun(run: SyncRunDocument): SerializedSyncRun {
    return {
        id: run._id?.toHexString() || "",
        trigger: run.trigger,
        status: run.status,
        additions: run.additions,
        removals: run.removals,
        conflicts: run.conflicts,
        skipped: run.skipped,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
        addedTracks: (run.addedTracks || []).map(serializeRunTrack),
        removedTracks: (run.removedTracks || []).map(serializeRunTrack),
        unmatchedTracks: (run.unmatchedTracks || []).map(serializeRunTrack)
    }
}

function tracksByKey(items: CanonicalTrack[]) {
    const grouped = new Map<string, CanonicalTrack[]>()
    for (const item of items) {
        grouped.set(item.canonicalKey, [...(grouped.get(item.canonicalKey) || []), item])
    }
    return grouped
}

function trackReferenceFromSnapshot(item: CanonicalTrack, side: SyncTaskDocument["source"]): SyncRunTrackReference {
    return {
        providerAccountId: side.providerAccountId,
        playlistId: side.playlistId,
        providerTrackId: item.providerTrackId,
        providerItemId: item.providerItemId,
        title: item.title,
        artists: item.artists,
        playlistName: side.name
    }
}

// Recover unmatched songs from the post-run snapshot when a run did not store titles.
export function unmatchedTracksFromSnapshot(snapshot: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems">, task: Pick<SyncTaskDocument, "source" | "destination" | "direction" | "mode">): SyncRunTrackReference[] {
    const oneWay = resolvedTaskDirection(task) === "one-way"
    const sourceByKey = tracksByKey(snapshot.sourceItems)
    const destinationByKey = tracksByKey(snapshot.destinationItems)
    const unmatched: SyncRunTrackReference[] = []
    for (const key of new Set([...sourceByKey.keys(), ...destinationByKey.keys()])) {
        const sourceItems = sourceByKey.get(key) || []
        const destinationItems = destinationByKey.get(key) || []
        if (sourceItems.length > destinationItems.length) {
            unmatched.push(...sourceItems.slice(destinationItems.length).map((item) => trackReferenceFromSnapshot(item, task.source)))
        }
        if (!oneWay && destinationItems.length > sourceItems.length) {
            unmatched.push(...destinationItems.slice(sourceItems.length).map((item) => trackReferenceFromSnapshot(item, task.destination)))
        }
    }
    return unmatched
}

export function runNeedsUnmatchedBackfill(run: Pick<SyncRunDocument, "unmatchedTracks">) {
    return !(run.unmatchedTracks && run.unmatchedTracks.length)
}

// Serialize a sync task. Latest-run counts are visible to every account.
export function serializeSyncTask(task: SyncTaskDocument, latestRun: LatestRunSummary | undefined, _tier: AccountTier, entitlementLocked = false) {
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
        latestRun
    }
}
