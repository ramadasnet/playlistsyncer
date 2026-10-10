// Client-side representations returned by the server API.
import type {AccountTier, Provider, SyncRunStatus, SyncTaskDirection, SyncTaskMode, SyncTaskStatus} from "~~/shared/types/domain"
import type {ReverseSyncRequest, SyncFailureReason} from "~~/shared/reverse-sync"

// Public authenticated session data.
export interface SessionUser {
    id: string
    email?: string
    tempEmail?: string
    displayName: string
    avatarUrl?: string
    tier: AccountTier
    developmentProOverride: boolean
    trialAccess: boolean
    proSubscriptionRequiredAt?: string
    weeklySyncSummaryEnabled: boolean
    creemSubscriptionStatus?: string
}

// Connected provider account summary.
export interface ConnectedAccount {
    id: string
    provider: Provider
    displayName: string
    email?: string
    playlistCount?: number
    connectedAt: string
    tokenExpiresAt?: string
}

// Provider playlist summary used by selection views.
export interface PlaylistSummary {
    id: string
    name: string
    description?: string
    imageUrl?: string
    itemCount: number
}

// Serialized synchronization task and its latest visible run.
export interface SyncTaskSummary {
    id: string
    mode: SyncTaskMode
    direction: SyncTaskDirection
    source: {providerAccountId: string; playlistId: string; name: string}
    destination: {providerAccountId: string; playlistId: string; name: string}
    status: SyncTaskStatus
    pauseReason?: "user" | "entitlement"
    entitlementLocked?: boolean
    nextRunAt: string
    lastRunAt?: string
    lastSuccessAt?: string
    lastError?: string
    createdAt?: string
    leaseExpiresAt?: string
    latestRun?: {
        status: SyncRunStatus
        additions: number
        removals: number
        conflicts: number
        skipped: number
        startedAt: string
        progress?: {
            playlistsTotal?: number
            playlistsCompleted?: number
            tracksTotal?: number
        }
    }
}

export interface SyncRunTrack {
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

export interface SimilarTrackSuggestion {
    trackId: string
    title: string
    artists: string[]
    album?: string
    durationMs?: number
    imageUrl?: string
}

export interface SyncTaskDetail {
    task: SyncTaskSummary
    sourceProvider: Provider | null
    destinationProvider: Provider | null
    playlistMappings: {sourcePlaylistId: string; destinationPlaylistId: string; name: string}[]
    canBrowseHistory: boolean
    runs: SyncRunDetail[]
}

export interface SyncRunDetail {
    id: string
    trigger: "created" | "manual" | "scheduled"
    status: SyncRunStatus
    additions: number
    removals: number
    conflicts: number
    skipped: number
    startedAt: string
    finishedAt?: string
    error?: string
    failureReason?: SyncFailureReason
    reverseSync?: ReverseSyncRequest
    availableReverseSync?: ReverseSyncRequest
    progress?: {
        playlistsTotal?: number
        playlistsCompleted?: number
        tracksTotal?: number
    }
    addedTracks: SyncRunTrack[]
    removedTracks: SyncRunTrack[]
    unmatchedTracks: SyncRunTrack[]
    failedPlaylists?: SyncRunPlaylistIssue[]
    missingSourcePlaylists?: SyncRunPlaylistIssue[]
}

// A full-sync playlist that failed or whose source playlist is gone.
export interface SyncRunPlaylistIssue {
    sourcePlaylistId: string
    destinationPlaylistId?: string
    name: string
    error?: string
}
