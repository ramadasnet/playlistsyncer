// Spotify connector: uses the web player's internal APIs from inside an open.spotify.com tab, with headers captured from the player's own requests.
import type {ExtensionPlaylist, ExtensionProviderAccount, ExtensionTrack} from "../../../shared/types/extension"
import {spotifyPatterns} from "../hosts"
import {openProviderTab, pageFetch, runInTab} from "../tabs"
import {getLocal, mapLimit, parseJson, requestHeadersSpec, searchText, setLocal, waitFor} from "../util"
import {ProviderError, type ProviderConnector} from "./types"

interface SpotifyHeaders {
    authorization: string
    clientToken?: string
    appVersion?: string
    capturedAt: number
}

interface TrackMeta {
    isrc?: string
    durationMs?: number
}

const webPlayerUrl = "https://open.spotify.com/"
const tabPatterns = ["https://open.spotify.com/*"]
const pathfinderUrl = "https://api-partner.spotify.com/pathfinder/v2/query"
const spclient = "https://spclient.wg.spotify.com"
const headersMaxAgeMs = 50 * 60_000
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// Persisted query hashes of the current build, used when the bundle scan and live capture miss an operation.
const fallbackHashes: Record<string, string> = {
    searchTracks: "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751",
    fetchPlaylistContents: "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf",
    fetchPlaylist: "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf",
    fetchPlaylistMetadata: "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf",
    addToPlaylist: "b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a",
    removeFromPlaylist: "b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a",
    playlistPermissions: "e43d1d35f231cf289c23c9d9c489f4a4f502e4eda09839c530608f107b6556b8"
}

let loaded = false
let headers: SpotifyHeaders | undefined
let seenAt = 0
// Tokens rejected with 401, ignored when our own requests carry them again.
const rejected = new Set<string>()
let liveHashes: Record<string, string> = {}
let bundleHashes: {appVersion: string; hashes: Record<string, string>} | undefined
let profile: {authorization: string; account: ExtensionProviderAccount | null} | undefined

// Capture the web player auth headers from its own requests.
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const get = (name: string) => details.requestHeaders?.find((h) => h.name.toLowerCase() === name)?.value
        const authorization = get("authorization")
        if (!authorization?.startsWith("Bearer ") || rejected.has(authorization)) return undefined
        seenAt = Date.now()
        const clientToken = get("client-token") ?? headers?.clientToken
        const appVersion = get("spotify-app-version") ?? headers?.appVersion
        // A token still used by the player after 50 minutes was refreshed by Spotify, so it counts as fresh again.
        if (!headers || headers.authorization !== authorization || headers.clientToken !== clientToken || headers.appVersion !== appVersion || !isFresh(headers)) {
            headers = {authorization, clientToken, appVersion, capturedAt: Date.now()}
            void setLocal({spotifyHeaders: headers})
        }
        return undefined
    },
    {urls: spotifyPatterns},
    requestHeadersSpec
)

// Learn persisted query hashes from the player's own pathfinder requests.
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const bytes = details.requestBody?.raw?.[0]?.bytes
        const body = bytes ? parseJson(new TextDecoder().decode(bytes)) : undefined
        const params = new URL(details.url).searchParams
        const operationName = body?.operationName ?? params.get("operationName")
        const hash = body?.extensions?.persistedQuery?.sha256Hash ?? parseJson(params.get("extensions") ?? "")?.extensions?.persistedQuery?.sha256Hash
        if (typeof operationName === "string" && typeof hash === "string" && liveHashes[operationName] !== hash) {
            liveHashes[operationName] = hash
            void setLocal({spotifyLiveHashes: liveHashes})
        }
        return undefined
    },
    {urls: ["https://api-partner.spotify.com/pathfinder/*"]},
    ["requestBody"]
)

// Load the cached headers and hashes once per background start.
async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    const stored = (await chrome.storage.local.get(["spotifyHeaders", "spotifyLiveHashes", "spotifyBundleHashes"])) as {spotifyHeaders?: SpotifyHeaders; spotifyLiveHashes?: Record<string, string>; spotifyBundleHashes?: typeof bundleHashes}
    headers ??= stored.spotifyHeaders
    liveHashes = {...stored.spotifyLiveHashes, ...liveHashes}
    bundleHashes = stored.spotifyBundleHashes
}

// Whether captured headers are recent enough to use.
function isFresh(value?: SpotifyHeaders): value is SpotifyHeaders {
    return !!value && Date.now() - value.capturedAt < headersMaxAgeMs
}

// Get a web player tab and fresh auth headers, reloading or opening a player tab when they are stale or rejected.
async function session(refresh = false): Promise<{tabId: number; headers: SpotifyHeaders}> {
    await load()
    if (!refresh && isFresh(headers)) return {tabId: await openProviderTab(webPlayerUrl, tabPatterns), headers}
    if (refresh && headers) {
        rejected.add(headers.authorization)
        headers = undefined
    }
    const since = Date.now()
    const tabId = await openProviderTab(webPlayerUrl, tabPatterns, true)
    const fresh = await waitFor(() => (seenAt >= since && isFresh(headers) ? headers : undefined), 30_000)
    if (!fresh) throw new ProviderError("Could not read the Spotify web player session, open open.spotify.com and try again", "auth")
    return {tabId, headers: fresh}
}

// Request a Spotify web player API from inside the tab; retries once with fresh headers on 401.
async function spotifyFetch(url: string, method = "GET", body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        const s = await session(attempt > 0)
        const h: Record<string, string> = {accept: "application/json", "app-platform": "WebPlayer", authorization: s.headers.authorization}
        if (s.headers.clientToken) h["client-token"] = s.headers.clientToken
        if (s.headers.appVersion) h["spotify-app-version"] = s.headers.appVersion
        if (body !== undefined) h["content-type"] = "application/json;charset=UTF-8"
        const res = await runInTab(s.tabId, pageFetch, [url, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)}])
        if (res.status === 401 && attempt === 0) continue
        if (res.status === 401) throw new ProviderError("Spotify rejected the web player session", "auth")
        if (res.status === 429) throw new ProviderError("Spotify rate limit reached", "rate_limit")
        if (res.status === 404) throw new ProviderError(`Spotify resource not found: ${url}`, "not_found")
        if (res.status === 0 || res.status >= 400) throw new ProviderError(`Spotify request failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`)
        return res.text ? (parseJson(res.text) ?? res.text) : null
    }
}

// Collect persisted query hashes from the web player bundles (injected, must stay self-contained).
async function spotifyBundleHashes(): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {}
    const sources = new Set([...Array.from(document.scripts).map((s) => s.src), ...performance.getEntriesByType("resource").map((e) => e.name)].filter((src) => /web-player.*\.js(\?|$)/.test(src)))
    for (const src of sources) {
        try {
            const text = await (await fetch(src)).text()
            for (const match of text.matchAll(/"(\w+)","(query|mutation)","([0-9a-f]{64})"/g)) hashes[match[1]!] = match[3]!
        } catch {}
    }
    return hashes
}

// Hash of a pathfinder operation: live capture first, then the bundle of the current app version, then the fallback constants.
async function hashFor(operationName: string, refresh: boolean): Promise<string> {
    await load()
    if (!refresh && liveHashes[operationName]) return liveHashes[operationName]
    const appVersion = headers?.appVersion ?? ""
    if (refresh || bundleHashes?.appVersion !== appVersion) {
        const {tabId} = await session()
        bundleHashes = {appVersion, hashes: (await runInTab(tabId, spotifyBundleHashes, [])) ?? {}}
        await setLocal({spotifyBundleHashes: bundleHashes})
    }
    const hash = bundleHashes.hashes[operationName] ?? fallbackHashes[operationName]
    if (!hash) throw new ProviderError(`Spotify operation ${operationName} is not available in this web player version`, "unsupported")
    return hash
}

// Run a pathfinder GraphQL operation, refreshing the hash once if Spotify no longer knows it.
async function pathfinder(operationName: string, variables: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        let body: any
        try {
            const sha256Hash = await hashFor(operationName, attempt > 0)
            body = await spotifyFetch(pathfinderUrl, "POST", {variables, operationName, extensions: {persistedQuery: {version: 1, sha256Hash}}})
        } catch (err) {
            if (attempt === 0 && /PersistedQueryNotFound/i.test(String(err))) {
                delete liveHashes[operationName]
                continue
            }
            throw err
        }
        if (attempt === 0 && /PersistedQueryNotFound/i.test(JSON.stringify(body?.errors ?? ""))) {
            delete liveHashes[operationName]
            continue
        }
        if (body?.errors?.length && !body.data) throw new ProviderError(`Spotify ${operationName}: ${body.errors[0]?.message ?? "failed"}`)
        return body?.data
    }
}

// Base62 ID of a Spotify URI of the given kind.
function idFromUri(uri: unknown, kind: string): string | undefined {
    return typeof uri === "string" && uri.startsWith(`spotify:${kind}:`) ? uri.slice(kind.length + 9) : undefined
}

// Convert a base62 track ID to the 32 hex digit GID used by the metadata API.
function toHexGid(id: string): string {
    let n = 0n
    for (const c of id) n = n * 62n + BigInt(base62.indexOf(c))
    return n.toString(16).padStart(32, "0")
}

// Convert a pathfinder track to an extension track; non-tracks (episodes, local files, removed tracks) are unavailable.
function toTrack(data: any, itemId?: string): ExtensionTrack {
    const trackId = idFromUri(data?.uri, "track")
    if (data?.__typename !== "Track" || !trackId) return {itemId: itemId ?? "", trackId: trackId ?? data?.uri ?? "", title: data?.name ?? "", artists: [], unavailable: true}
    return {
        itemId: itemId ?? trackId,
        trackId,
        title: data.name ?? "",
        artists: (data.artists?.items ?? []).map((a: any) => a?.profile?.name).filter(Boolean),
        album: data.albumOfTrack?.name || undefined,
        durationMs: data.trackDuration?.totalMilliseconds ?? data.duration?.totalMilliseconds ?? undefined,
        imageUrl: data.albumOfTrack?.coverArt?.sources?.[0]?.url || undefined,
        url: `https://open.spotify.com/track/${trackId}`
    }
}

// ISRC and duration of tracks from the metadata API, cached in storage, 4 requests at a time.
async function trackMeta(ids: string[]): Promise<Record<string, TrackMeta>> {
    const cached = (await chrome.storage.local.get(ids.map((id) => `sp:${id}`))) as Record<string, TrackMeta>
    const result: Record<string, TrackMeta> = {}
    const fetched: Record<string, TrackMeta> = {}
    const missing = ids.filter((id) => !(result[id] = cached[`sp:${id}`]))
    try {
        await mapLimit(missing, 4, async (id) => {
            try {
                const body = await spotifyFetch(`${spclient}/metadata/4/track/${toHexGid(id)}?market=from_token`)
                const meta = {isrc: body?.external_id?.find((e: any) => e?.type === "isrc")?.id, durationMs: body?.duration}
                result[id] = fetched[`sp:${id}`] = meta
            } catch (err) {
                if (err instanceof ProviderError && (err.code === "auth" || err.code === "rate_limit")) throw err
            }
        })
    } finally {
        if (Object.keys(fetched).length) await setLocal(fetched)
    }
    return result
}

// Add ISRCs (and missing durations) to tracks.
async function enrich(tracks: ExtensionTrack[]): Promise<void> {
    const meta = await trackMeta([...new Set(tracks.filter((t) => !t.unavailable).map((t) => t.trackId))])
    for (const track of tracks) {
        const m = meta[track.trackId]
        if (!m) continue
        track.isrc ??= m.isrc
        track.durationMs ??= m.durationMs
    }
}

// Search tracks with the web player search.
async function searchTracks(searchTerm: string): Promise<ExtensionTrack[]> {
    const variables = {searchTerm, offset: 0, limit: 20, numberOfTopResults: 20, includeAudiobooks: false, includePreReleases: false, includeAlbumPreReleases: false, includeAuthors: false, includeEpisodeContentRatingsV2: false}
    const data = await pathfinder("searchTracks", variables)
    return (data?.searchV2?.tracksV2?.items ?? []).map((i: any) => toTrack(i?.item?.data)).filter((t: ExtensionTrack) => !t.unavailable)
}

// The signed-in user, cached per access token; null for anonymous sessions.
async function account(): Promise<ExtensionProviderAccount | null> {
    const s = await session()
    if (profile?.authorization === s.headers.authorization) return profile.account
    // Unverified: response shape of profileAttributes for signed-in users.
    const p = (await pathfinder("profileAttributes", {}))?.me?.profile
    const result: ExtensionProviderAccount | null = p?.username ? {provider: "spotify", accountId: p.username, displayName: p.name || p.username, imageUrl: p.avatar?.sources?.[0]?.url || undefined} : null
    profile = {authorization: s.headers.authorization, account: result}
    return result
}

// Username of the signed-in user, or an auth error.
async function username(): Promise<string> {
    const result = await account()
    if (!result) throw new ProviderError("Not signed in to Spotify", "auth")
    return result.accountId
}

// Apply one operation to the user's playlist library (rootlist).
async function rootlistChange(user: string, op: unknown): Promise<void> {
    // Unverified: rootlist changes request format taken from the web player bundle.
    await spotifyFetch(`${spclient}/playlist/v2/user/${encodeURIComponent(user)}/rootlist/changes`, "POST", {deltas: [{ops: [op], info: {source: {client: "WEBPLAYER"}}}], wantResultingRevisions: false, wantSyncResult: false, nonces: []})
}

// List playlists from the rootlist API.
async function rootlistPlaylists(user: string, writableOnly?: boolean): Promise<ExtensionPlaylist[]> {
    const playlists: ExtensionPlaylist[] = []
    for (let from = 0; ; from += 500) {
        // Unverified: rootlist response shape for signed-in users.
        const body = await spotifyFetch(`${spclient}/playlist/v2/user/${encodeURIComponent(user)}/rootlist?decorate=revision,length,attributes,timestamp,owner&from=${from}&length=500`)
        const items: any[] = body?.contents?.items
        if (!Array.isArray(items)) throw new ProviderError("Unexpected Spotify rootlist response")
        const metaItems: any[] = body.contents.metaItems ?? []
        // Meta items should align with items; if folders are not counted there, align them with playlists only.
        const playlistItems = items.filter((item) => idFromUri(item?.uri, "playlist"))
        const aligned = metaItems.length === items.length ? items : playlistItems
        for (const item of playlistItems) {
            const id = idFromUri(item.uri, "playlist")!
            const meta = metaItems[aligned.indexOf(item)] ?? {}
            if (writableOnly && meta.ownerUsername !== user && !meta.attributes?.collaborative) continue
            playlists.push({id, name: meta.attributes?.name ?? id, description: meta.attributes?.description || undefined, itemCount: meta.length ?? undefined})
        }
        if (items.length < 500) return playlists
    }
}

// List playlists from the pathfinder library, used when the rootlist API fails.
async function libraryPlaylists(user: string, writableOnly?: boolean): Promise<ExtensionPlaylist[]> {
    const playlists: ExtensionPlaylist[] = []
    for (let offset = 0; ; offset += 50) {
        // Unverified: libraryV3 response shape.
        const variables = {filters: ["Playlists"], order: null, textFilter: "", features: [], limit: 50, offset, flatten: true, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: true}
        const items: any[] = (await pathfinder("libraryV3", variables))?.me?.libraryV3?.items ?? []
        for (const item of items) {
            const data = item?.item?.data
            const id = idFromUri(data?.uri, "playlist")
            if (!id || (writableOnly && data?.ownerV2?.data?.username !== user)) continue
            playlists.push({id, name: data.name ?? id, description: data.description || undefined, imageUrl: data.images?.items?.[0]?.sources?.[0]?.url || undefined})
        }
        if (items.length < 50) return playlists
    }
}

export const spotify: ProviderConnector = {
    provider: "spotify",
    name: "Spotify",
    loginUrl: "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F",
    tabPatterns,

    // Detect the signed-in Spotify user.
    async detectAccount() {
        try {
            return await account()
        } catch (err) {
            if (err instanceof ProviderError && err.code === "auth") return null
            throw err
        }
    },

    // List the user's playlists, optionally only owned or collaborative ones.
    async listPlaylists({writableOnly}) {
        const user = await username()
        try {
            return await rootlistPlaylists(user, writableOnly)
        } catch (err) {
            if (err instanceof ProviderError && (err.code === "auth" || err.code === "rate_limit")) throw err
            return libraryPlaylists(user, writableOnly)
        }
    },

    // Create a playlist and add it to the user's library.
    async createPlaylist({name, description}) {
        const user = await username()
        // Unverified: playlist creation request format taken from the web player bundle.
        const values = {name, ...(description ? {description} : {}), formatAttributes: [], pictureSize: []}
        const created = await spotifyFetch(`${spclient}/playlist/v2/playlist`, "POST", {ops: [{kind: "UPDATE_LIST_ATTRIBUTES", updateListAttributes: {newAttributes: {values, noValue: []}}}], info: {source: {client: "WEBPLAYER"}}})
        const id = idFromUri(created?.uri, "playlist")
        if (!id) throw new ProviderError("Spotify did not return the created playlist")
        await rootlistChange(user, {kind: "ADD", add: {addFirst: true, items: [{uri: created.uri, attributes: {timestamp: String(Date.now()), formatAttributes: [], availableSignals: []}}]}})
        return {id, name, description, itemCount: 0}
    },

    // Delete a playlist by removing (unfollowing) it from the user's library.
    async deletePlaylist({playlistId}) {
        await rootlistChange(await username(), {kind: "REM", rem: {itemsAsKey: true, items: [{uri: `spotify:playlist:${playlistId}`}]}})
        return null
    },

    // Read all items of a playlist, with ISRCs.
    async getPlaylistItems({playlistId}) {
        const tracks: ExtensionTrack[] = []
        for (let offset = 0; ;) {
            const content = (await pathfinder("fetchPlaylistContents", {uri: `spotify:playlist:${playlistId}`, offset, limit: 100}))?.playlistV2?.content
            if (!content) throw new ProviderError(`Spotify playlist ${playlistId} not found`, "not_found")
            const items: any[] = content.items ?? []
            for (const item of items) tracks.push(toTrack(item?.itemV2?.data, item?.uid ?? ""))
            offset += items.length
            if (!items.length || offset >= (content.totalCount ?? 0)) break
        }
        await enrich(tracks)
        return tracks
    },

    // Search by ISRC first, then by title and artist; the top candidates get their ISRC.
    async searchTrackCandidates({track}) {
        let results = track.isrc ? await searchTracks(`isrc:${track.isrc}`) : []
        if (!results.length) results = await searchTracks(searchText(track))
        await enrich(results.slice(0, 5))
        return results
    },

    // Durations from the metadata API (cached).
    async getTrackDurations({trackIds}) {
        const meta = await trackMeta(trackIds)
        const durations: Record<string, number> = {}
        for (const id of trackIds) {
            const ms = meta[id]?.durationMs
            if (ms) durations[id] = ms
        }
        return durations
    },

    // Append tracks at the end of a playlist. Item IDs are not returned.
    async addTracks({playlistId, trackIds}) {
        // Unverified: addToPlaylist variables taken from the web player bundle.
        await pathfinder("addToPlaylist", {playlistUri: `spotify:playlist:${playlistId}`, playlistItemUris: trackIds.map((id) => `spotify:track:${id}`), newPosition: {moveType: "BOTTOM_OF_PLAYLIST", fromUid: null}, interactionId: null})
        return trackIds.map((id) => ({providerTrackId: id}))
    },

    // Remove playlist entries by their uid.
    async removePlaylistItems({playlistId, itemIds}) {
        // Unverified: removeFromPlaylist variables taken from the web player bundle.
        await pathfinder("removeFromPlaylist", {playlistUri: `spotify:playlist:${playlistId}`, uids: itemIds})
        return null
    }
}
