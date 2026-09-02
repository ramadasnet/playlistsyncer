import type {ObjectId} from "mongodb"

export const providers = ["spotify", "amazon", "youtube", "tidal"] as const

export type Provider = (typeof providers)[number]

export interface ProviderFlags {
    disabled?: boolean
}

export const providerFlags: Record<Provider, ProviderFlags> = {
    amazon: {disabled: true},
    spotify: {},
    tidal: {},
    youtube: {}
}

export const providerDisplayNames: Record<Provider, string> = {
    amazon: "Amazon Music",
    spotify: "Spotify",
    tidal: "TIDAL",
    youtube: "YouTube Music"
}

export function isProviderEnabled(provider: Provider) {
    return !providerFlags[provider].disabled
}

export const enabledProviders = providers.filter(isProviderEnabled)

export function formatProviderNames(list: readonly Provider[] = enabledProviders) {
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
export type SyncTaskStatus = "active" | "paused" | "needs_attention"
export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed"

export interface UserDocument {
    _id?: ObjectId
    email: string
    displayName: string
    avatarUrl?: string
    tier: AccountTier
    creemCustomerId?: string
    creemSubscriptionId?: string
    creemSubscriptionStatus?: string
    createdAt: Date
    updatedAt: Date
}

export interface EncryptedValue {
    version: number
    iv: string
    ciphertext: string
}

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

export interface SessionDocument {
    _id?: ObjectId
    userId: ObjectId
    tokenHash: string
    expiresAt: Date
    createdAt: Date
}

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

export interface PlaylistReference {
    providerAccountId: ObjectId
    playlistId: string
    name: string
}

export interface PlaylistMapping {
    sourcePlaylistId: string
    destinationPlaylistId: string
    name: string
}

export interface SyncTaskDocument {
    _id?: ObjectId
    userId: ObjectId
    mode?: SyncTaskMode
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

export interface SyncSnapshotDocument {
    _id?: ObjectId
    taskId: ObjectId
    matchingVersion?: number
    sourceItems: CanonicalTrack[]
    destinationItems: CanonicalTrack[]
    createdAt: Date
}

export interface SyncRunTrackReference {
    providerAccountId: ObjectId
    playlistId: string
    providerTrackId: string
    providerItemId?: string
}

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
    error?: string
    startedAt: Date
    finishedAt?: Date
}

export interface WebhookEventDocument {
    _id?: ObjectId
    eventId: string
    type: string
    processedAt: Date
}
