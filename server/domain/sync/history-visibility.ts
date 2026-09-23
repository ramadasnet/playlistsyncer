// Control which synchronization history is visible at each account tier.
import type {AccountTier, CanonicalTrack, SyncRunDocument, SyncRunTrackReference, SyncSnapshotDocument, SyncTaskDocument} from "../../../shared/types/domain"

export type LatestRunSummary = Pick<SyncRunDocument, "status" | "additions" | "removals" | "conflicts" | "skipped" | "startedAt">

export const proRunHistoryLimit = 50

export interface SerializedRunTrack {
    title: string
    artists: string[]
    playlistName?: string
    playlistId?: string
    providerTrackId?: string
    providerItemId?: string
    providerAccountId?: string
    durationMs?: number
    side?: "source" | "destination"
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

function trackSide(track: SyncRunTrackReference, task?: Pick<SyncTaskDocument, "source" | "destination">): SerializedRunTrack["side"] {
    if (!task) return undefined
    if (track.providerAccountId.equals(task.destination.providerAccountId)) return "destination"
    if (track.providerAccountId.equals(task.source.providerAccountId)) return "source"
    return undefined
}

function snapshotDuration(track: SyncRunTrackReference, snapshot?: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems">) {
    if (!snapshot) return undefined
    const items = [...snapshot.sourceItems, ...snapshot.destinationItems]
    return items.find((item) => item.providerTrackId === track.providerTrackId || (track.providerItemId && item.providerItemId === track.providerItemId))?.durationMs
}

// Copy catalog durations onto stored run tracks that were saved without length.
export function withTrackDurations(tracks: SyncRunTrackReference[], durations: Map<string, number>): SyncRunTrackReference[] {
    return tracks.map((track) => {
        if (track.durationMs) return track
        const durationMs = durations.get(track.providerTrackId)
        return durationMs ? {...track, durationMs} : track
    })
}

// Public label for a stored run track.
export function serializeRunTrack(track: SyncRunTrackReference, task?: Pick<SyncTaskDocument, "source" | "destination">, snapshot?: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems">): SerializedRunTrack {
    const title = track.title.trim() || "Unknown track"
    const artists = track.artists.map((artist) => artist.trim()).filter(Boolean)
    const playlistName = track.playlistName?.trim()
    const side = trackSide(track, task)
    const durationMs = track.durationMs || snapshotDuration(track, snapshot)
    return {
        title,
        artists,
        ...(playlistName ? {playlistName} : {}),
        playlistId: track.playlistId,
        providerTrackId: track.providerTrackId,
        ...(track.providerItemId ? {providerItemId: track.providerItemId} : {}),
        providerAccountId: track.providerAccountId.toHexString(),
        ...(durationMs ? {durationMs} : {}),
        ...(side ? {side} : {})
    }
}

// Public representation of one synchronization run and its track lists.
export function serializeSyncRun(run: SyncRunDocument, task?: Pick<SyncTaskDocument, "source" | "destination">, snapshot?: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems">): SerializedSyncRun {
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
        addedTracks: run.addedTracks.map((track) => serializeRunTrack(track, task, snapshot)),
        removedTracks: run.removedTracks.map((track) => serializeRunTrack(track, task, snapshot)),
        unmatchedTracks: run.unmatchedTracks.map((track) => serializeRunTrack(track, task, snapshot))
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
        playlistName: side.name,
        ...(item.durationMs ? {durationMs: item.durationMs} : {})
    }
}

// Identify currently unmatched songs from the playlist snapshot for manual matching.
export function unmatchedTracksFromSnapshot(snapshot: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems">, task: Pick<SyncTaskDocument, "source" | "destination" | "direction" | "mode">): SyncRunTrackReference[] {
    const oneWay = task.direction === "one-way"
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

// Serialize a sync task. Latest-run counts are visible to every account.
export function serializeSyncTask(task: SyncTaskDocument, latestRun: LatestRunSummary | undefined, _tier: AccountTier, entitlementLocked = false) {
    return {
        id: task._id?.toHexString(),
        mode: task.mode,
        direction: task.direction,
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
