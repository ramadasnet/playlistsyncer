// Contract shared by the PlaylistSyncer server and the browser extension that runs provider operations in the user's browser.
import type {Provider} from "./domain"

// Providers that the browser extension can operate on behalf of the user.
export const extensionProviders = ["spotify", "amazon"] as const satisfies readonly Provider[]

export type ExtensionProvider = (typeof extensionProviders)[number]

// Check whether a provider is handled by the browser extension.
export function isExtensionProvider(provider: string): provider is ExtensionProvider {
    return (extensionProviders as readonly string[]).includes(provider)
}

// Provider adapter methods that the server can ask the extension to run.
export const extensionCommandMethods = ["listPlaylists", "createPlaylist", "deletePlaylist", "getPlaylistItems", "searchTrackCandidates", "getTrackDurations", "addTracks", "removePlaylistItems"] as const

export type ExtensionCommandMethod = (typeof extensionCommandMethods)[number]

// Playlist summary returned by the extension, same shape as the server ProviderPlaylist.
export interface ExtensionPlaylist {
    id: string
    name: string
    description?: string
    imageUrl?: string
    itemCount?: number
}

// Track returned by the extension, same shape as the server ProviderTrack.
export interface ExtensionTrack {
    itemId: string
    trackId: string
    title: string
    artists: string[]
    album?: string
    durationMs?: number
    isrc?: string
    imageUrl?: string
    url?: string
    unavailable?: boolean
}

// Arguments and results of each command method.
export interface ExtensionCommandMap {
    listPlaylists: {args: {writableOnly?: boolean}; result: ExtensionPlaylist[]}
    createPlaylist: {args: {name: string; description?: string}; result: ExtensionPlaylist}
    deletePlaylist: {args: {playlistId: string}; result: null}
    getPlaylistItems: {args: {playlistId: string}; result: ExtensionTrack[]}
    searchTrackCandidates: {args: {track: ExtensionTrack}; result: ExtensionTrack[]}
    // Durations in milliseconds keyed by track ID. Unknown tracks are omitted.
    getTrackDurations: {args: {trackIds: string[]}; result: Record<string, number>}
    // Returns the added track and item IDs in the same order as the request. The server sends at most 50 tracks per command.
    addTracks: {args: {playlistId: string; trackIds: string[]}; result: {providerTrackId: string; providerItemId?: string}[]}
    // The server sends at most 50 items per command.
    removePlaylistItems: {args: {playlistId: string; itemIds: string[]}; result: null}
}

// One provider operation queued by the server for the extension.
export interface ExtensionCommand<M extends ExtensionCommandMethod = ExtensionCommandMethod> {
    id: string
    provider: ExtensionProvider
    // The provider's own user ID, as reported by the extension in ExtensionProviderAccount.accountId.
    accountId: string
    method: M
    args: ExtensionCommandMap[M]["args"]
}

// Outcome of one command, sent by the extension to POST /api/extension/results.
export interface ExtensionCommandResult {
    id: string
    ok: boolean
    result?: unknown
    error?: {
        message: string
        // "auth" when the user is signed out of the provider, "rate_limit" when the provider throttles, "not_found" for a missing playlist.
        code?: "auth" | "rate_limit" | "not_found" | "unsupported" | "failed"
    }
}

// A provider session that the extension found in the browser.
export interface ExtensionProviderAccount {
    provider: ExtensionProvider
    accountId: string
    displayName: string
    imageUrl?: string
    // Amazon Music storefront domain suffix, for example "de" or "com".
    region?: string
}

// Body of POST /api/extension/poll. The server answers within about 8 seconds with the queued commands.
export interface ExtensionPollRequest {
    version: string
    browser: "chrome" | "firefox"
    accounts: ExtensionProviderAccount[]
}

// Response of POST /api/extension/poll.
export interface ExtensionPollResponse {
    commands: ExtensionCommand[]
    // Wait this long before the next poll when no commands were returned.
    retryAfterMs?: number
}

// Body of POST /api/extension/token, the OAuth 2.0 authorization code exchange with PKCE.
export interface ExtensionTokenRequest {
    grant_type: "authorization_code"
    code: string
    code_verifier: string
    redirect_uri: string
    // Extension version, recorded with the linked browser.
    version?: string
}

// Response of POST /api/extension/token.
export interface ExtensionTokenResponse {
    access_token: string
    token_type: "Bearer"
    user: {name: string; email?: string}
}

// Body of GET /api/extension/me.
export interface ExtensionMeResponse {
    user: {name: string; email?: string}
    // Tasks currently handled by this browser.
    tasks: {id: string; name: string; status: string; lastRunAt?: string; lastRunStatus?: string}[]
}

// Upper bound for track IDs sent in one addTracks or removePlaylistItems command.
export const extensionWriteBatchSize = 50
