// Shared persistence and synchronization contracts used by client and server code.
import type {ObjectId} from "mongodb"

// Providers recognized by the application and their feature flags.
export const providers = ["spotify", "tidal", "youtube", "amazon"] as const

export type Provider = (typeof providers)[number]

export interface ProviderFlags {
    disabled?: boolean
}

export const providerFlags: Record<Provider, ProviderFlags> = {
    spotify: {},
    tidal: {},
    youtube: {},
    amazon: {disabled: true}
}

export const providerDisplayNames: Record<Provider, string> = {
    spotify: "Spotify",
    tidal: "TIDAL",
    youtube: "YouTube Music",
    amazon: "Amazon Music"
}

// Check whether a provider is disabled by a static feature flag.
export function isProviderFlagEnabled(provider: Provider) {
    return !providerFlags[provider].disabled
}

// Format provider names as a human-readable list.
export function formatProviderNames(list: readonly Provider[]) {
    const names = list.map((provider) => providerDisplayNames[provider])
    if (names.length <= 1) {
        return names[0] ?? ""
    }
    if (names.length === 2) {
        return `${names[0]} and ${names[1]}`
    }
    return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
}

export type AccountTier = "free" | "pro"
export type SyncTaskMode = "playlist" | "account"
export type SyncTaskDirection = "two-way" | "one-way"
export type SyncTaskStatus = "active" | "paused" | "needs_attention"
export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed"

// Resolve legacy task records that omitted their explicit direction.
export function resolvedTaskDirection(task: {mode?: SyncTaskMode; direction?: SyncTaskDirection}): SyncTaskDirection {
    if (task.direction) return task.direction
    return task.mode === "account" ? "one-way" : "two-way"
}

// Persisted user account and entitlement state.
export interface UserDocument {
    _id?: ObjectId
    email?: string
    tempEmail?: string
    emailVerificationTokenHash?: string
    emailVerificationExpiresAt?: Date
    emailConfirmationSentAt?: Date
    displayName: string
    avatarUrl?: string
    tier: AccountTier
    weeklySyncSummaryEnabled?: boolean
    weeklySyncSummarySentAt?: Date
    weeklySyncSummaryLeaseExpiresAt?: Date
    creemCustomerId?: string
    creemSubscriptionId?: string
    creemSubscriptionStatus?: string
    createdAt: Date
    updatedAt: Date
}

// Versioned encrypted secret payload.
export interface EncryptedValue {
    version: number
    iv: string
    ciphertext: string
}

// OAuth credentials and profile data for one connected provider account.
export interface ProviderAccountDocument {
    _id?: ObjectId
    userId: ObjectId
    provider: Provider
    externalAccountId: string
    email?: string
    emailVerified: boolean
    displayName: string
    accessToken: EncryptedValue
    refreshToken?: EncryptedValue
    tokenExpiresAt?: Date
    scopes: string[]
    connectedAt: Date
    updatedAt: Date
}

// Hashed browser session with its expiry.
export interface SessionDocument {
    _id?: ObjectId
    userId: ObjectId
    tokenHash: string
    expiresAt: Date
    createdAt: Date
}

// Short-lived PKCE transaction used during OAuth login or linking.
export interface OAuthTransactionDocument {
    _id?: ObjectId
    provider: Provider
    stateHash: string
    codeVerifier: string
    linkingUserId?: ObjectId
    redirectAfter: string
    expiresAt: Date
    createdAt: Date
}

// Provider playlist selected as one side of a sync task.
export interface PlaylistReference {
    providerAccountId: ObjectId
    playlistId: string
    name: string
}

// Persistent mapping between source and destination account playlists.
export interface PlaylistMapping {
    sourcePlaylistId: string
    destinationPlaylistId: string
    name: string
}

// Scheduled synchronization task and its execution state.
export interface SyncTaskDocument {
    _id?: ObjectId
    userId: ObjectId
    mode?: SyncTaskMode
    direction?: SyncTaskDirection
    source: PlaylistReference
    destination: PlaylistReference
    playlistMappings?: PlaylistMapping[]
    status: SyncTaskStatus
    pauseReason?: "user" | "entitlement"
    nextRunAt: Date
    lastRunAt?: Date
    lastSuccessAt?: Date
    lastError?: string
    leaseId?: string
    leaseExpiresAt?: Date
    createdAt: Date
    updatedAt: Date
}

// Provider-independent track snapshot used for reconciliation.
export interface CanonicalTrack {
    occurrenceId: string
    canonicalKey: string
    isrc?: string
    title: string
    artists: string[]
    album?: string
    durationMs?: number
    providerItemId: string
    providerTrackId: string
}

// Last known source and destination state for a sync task.
export interface SyncSnapshotDocument {
    _id?: ObjectId
    taskId: ObjectId
    matchingVersion?: number
    sourceItems: CanonicalTrack[]
    destinationItems: CanonicalTrack[]
    createdAt: Date
}

// Track metadata stored in a synchronization run's change history.
export interface SyncRunTrackReference {
    providerAccountId: ObjectId
    playlistId: string
    providerTrackId: string
    providerItemId?: string
    title?: string
    artists?: string[]
    durationMs?: number
    playlistName?: string
}

// Execution result and audit information for one synchronization run.
export interface SyncRunDocument {
    _id?: ObjectId
    taskId: ObjectId
    trigger: "created" | "manual" | "scheduled"
    status: SyncRunStatus
    additions: number
    removals: number
    conflicts: number
    skipped: number
    addedTracks: SyncRunTrackReference[]
    removedTracks: SyncRunTrackReference[]
    unmatchedTracks?: SyncRunTrackReference[]
    error?: string
    startedAt: Date
    finishedAt?: Date
}

// Deduplication record for a verified billing webhook event.
export interface WebhookEventDocument {
    _id?: ObjectId
    eventId: string
    type: string
    processedAt: Date
}
