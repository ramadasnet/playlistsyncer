import type {
    AccountTier,
    Provider,
    SyncRunStatus,
    SyncTaskDirection,
    SyncTaskMode,
    SyncTaskStatus
} from "~~/shared/types/domain"

export interface SessionUser {
    id: string
    email?: string
    tempEmail?: string
    displayName: string
    avatarUrl?: string
    tier: AccountTier
    developmentProOverride: boolean
    creemSubscriptionStatus?: string
}

export interface ConnectedAccount {
    id: string
    provider: Provider
    displayName: string
    email?: string
    playlistCount?: number
    connectedAt: string
    tokenExpiresAt?: string
}

export interface PlaylistSummary {
    id: string
    name: string
    description?: string
    imageUrl?: string
    itemCount: number
}

export interface SyncTaskSummary {
    id: string
    mode?: SyncTaskMode
    direction: SyncTaskDirection
    source: {providerAccountId: string; playlistId: string; name: string}
    destination: {providerAccountId: string; playlistId: string; name: string}
    status: SyncTaskStatus
    nextRunAt: string
    lastRunAt?: string
    lastSuccessAt?: string
    lastError?: string
    latestRun?: {
        status: SyncRunStatus
        additions: number
        removals: number
        conflicts: number
        skipped: number
        startedAt: string
    }
}
