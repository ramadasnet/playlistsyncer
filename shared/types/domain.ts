// Shared persistence and synchronization contracts used by client and server code.
import type {ObjectId} from "mongodb"

// Providers recognized by the application and their feature flags.
export const providers = ["spotify", "tidal", "youtube", "soundcloud", "amazon"] as const

export type Provider = (typeof providers)[number]

export interface ProviderFlags {
    disabled?: boolean
}

export const providerFlags: Record<Provider, ProviderFlags> = {
    spotify: {},
    tidal: {},
    youtube: {},
    soundcloud: {},
    amazon: {disabled: true}
}

export const providerDisplayNames: Record<Provider, string> = {
    spotify: "Spotify",
    tidal: "TIDAL",
    youtube: "YouTube Music",
    soundcloud: "SoundCloud",
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

// Find an all-playlists task covering this provider pair in either direction, since the mirror account must not sync back to its master.
export function findAccountSyncBetweenProviders<T extends {mode: SyncTaskMode; sourceProvider: Provider; destinationProvider: Provider}>(tasks: readonly T[], sourceProvider: Provider, destinationProvider: Provider): T | undefined {
    return tasks.find((task) => task.mode === "account" && ((task.sourceProvider === sourceProvider && task.destinationProvider === destinationProvider) || (task.sourceProvider === destinationProvider && task.destinationProvider === sourceProvider)))
}

// Build an order-independent key identifying a provider pair, used to enforce one all-playlists sync per pair atomically.
export function accountSyncProviderPairKey(providerA: Provider, providerB: Provider): string {
    return [providerA, providerB].sort().join(":")
}

// Explain why a new task conflicts with an existing all-playlists task.
export function accountSyncConflictMessage(task: {sourceProvider: Provider; destinationProvider: Provider}) {
    return `There's already a full sync from ${providerDisplayNames[task.sourceProvider]} to ${providerDisplayNames[task.destinationProvider]}. Delete it if you want to create another sync task between these providers.`
}

// Return the all-playlists tasks blocking every pair of connected accounts, or nothing when at least one pair can still be synced.
export function accountSyncsBlockingAllPairs<T extends {mode: SyncTaskMode; sourceProvider: Provider; destinationProvider: Provider}>(tasks: readonly T[], accountProviders: readonly Provider[]): T[] {
    const blocking = new Set<T>()
    for (let i = 0; i < accountProviders.length; i++) {
        for (let j = i + 1; j < accountProviders.length; j++) {
            const task = findAccountSyncBetweenProviders(tasks, accountProviders[i]!, accountProviders[j]!)
            if (!task) return []
            blocking.add(task)
        }
    }
    return [...blocking]
}

// Explain that every connected provider pair is already covered by full syncs.
export function allPairsBlockedMessage(tasks: readonly {sourceProvider: Provider; destinationProvider: Provider}[]) {
    if (tasks.length === 1) return accountSyncConflictMessage(tasks[0]!)
    return "All your connected providers are already covered by full syncs. Delete one of them if you want to create another sync task."
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
    codeVerifier: EncryptedValue
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
export interface ManualTrackAlias {
    sourceTrackId: string
    sourceItemId?: string
    destinationTrackId: string
    destinationItemId?: string
    canonicalKey: string
}

export interface PlaylistMapping {
    sourcePlaylistId: string
    destinationPlaylistId: string
    name: string
    manualAliases?: ManualTrackAlias[]
}

// Scheduled synchronization task and its execution state.
export interface SyncTaskDocument {
    _id?: ObjectId
    userId: ObjectId
    mode: SyncTaskMode
    direction: SyncTaskDirection
    accountSyncPairKey?: string
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
    title: string
    artists: string[]
    durationMs?: number
    playlistName?: string
}

// Live counters written while a synchronization run is still in progress.
export interface SyncRunProgress {
    playlistsTotal?: number
    playlistsCompleted?: number
    tracksTotal?: number
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
    unmatchedTracks: SyncRunTrackReference[]
    progress?: SyncRunProgress
    error?: string
    startedAt: Date
    finishedAt?: Date
}

// Deduplication record for a verified billing webhook event.
export interface WebhookEventDocument {
    _id?: ObjectId
    eventId: string
    type: string
    status?: "processing" | "processed" | "failed"
    processedAt: Date
}
