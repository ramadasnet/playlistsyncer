// Amazon Music connector: runs the web app's GraphQL API inside a music.amazon.<tld> tab with the user's cookies.
import type {ExtensionPlaylist, ExtensionTrack} from "../../../shared/types/extension"
import {amazonGqlPatterns, amazonTabPatterns} from "../hosts"
import {openProviderTab, pageFetch, runInTab} from "../tabs"
import {getLocal, mapLimit, requestHeadersSpec, searchText, setLocal, waitFor} from "../util"
import {ProviderError, type ProviderConnector} from "./types"

interface AmazonSession {
    tabId: number
    tld: string
    endpoint: string
    headers: Record<string, string>
}

const tldPattern = /\.amazon\.(com|ca|com\.br|com\.mx|co\.uk|de|fr|it|es|in|co\.jp|com\.au)$/
const trackFields = "id title isrc duration url album { title } contributingArtists(limit: 10) { edges { node { name } } }"
const itemsQuery = `query($id: String!, $limit: Float, $cursor: String) { playlist(id: $id) { uri trackCount tracks(limit: $limit, cursor: $cursor) { pageInfo { hasNextPage token } edges { itemId node { __typename ... on Track { ${trackFields} } } } } } }`
const searchQuery = `query($searchText: String!, $specifications: [SearchSpecification]) { specificationSearch(specificationSearchInput: {searchText: $searchText, specifications: $specifications}) { result { edges { node { __typename ... on Track { ${trackFields} } } } } } }`
let apiKey: string | undefined

// Capture the public web API key from the app's own GraphQL requests.
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const key = details.requestHeaders?.find((h) => h.name.toLowerCase() === "x-api-key")?.value
        if (key && key !== apiKey) {
            apiKey = key
            void setLocal({amazonApiKey: key})
        }
        return undefined
    },
    {urls: amazonGqlPatterns},
    requestHeadersSpec
)

// Read the web app session config inside the page (injected, must stay self-contained), optionally scanning the app bundles for the API key.
async function amazonPageConfig(scanForKey: boolean) {
    const w = window as any
    for (let i = 0; i < 40 && !w.amznMusic?.appConfig; i++) await new Promise((resolve) => setTimeout(resolve, 500))
    const c = w.amznMusic?.appConfig
    let key: string | undefined
    if (c && scanForKey) {
        const sources = new Set([...Array.from(document.scripts).map((s) => s.src), ...performance.getEntriesByType("resource").map((e) => e.name)].filter((src) => src && /\.js(\?|$)/.test(src)))
        for (const src of sources) {
            try {
                const match = (await (await fetch(src)).text()).match(/FIREFLY_WEB_API_KEY\s*[:=]\s*["']([^"']+)["']/)
                if (match) {
                    key = match[1]
                    break
                }
            } catch {}
        }
    }
    const config = c
        ? {
              deviceId: String(c.deviceId ?? ""),
              deviceType: String(c.deviceType ?? ""),
              musicTerritory: String(c.musicTerritory ?? ""),
              sessionId: String(c.sessionId ?? ""),
              csrfRnd: String(c.csrf?.rnd ?? ""),
              csrfToken: String(c.csrf?.token ?? ""),
              csrfTs: String(c.csrf?.ts ?? "")
          }
        : null
    return {host: location.hostname, signedIn: !!c?.customerId && c?.isAuthenticated !== false, config, key}
}

// Open (or reuse) an Amazon Music tab and build the GraphQL request headers.
async function session(): Promise<AmazonSession> {
    const region = (await getLocal<string>("amazonRegion")) ?? "com"
    const tabId = await openProviderTab(`https://music.amazon.${region}/`, amazonTabPatterns)
    apiKey ??= (await getLocal<string>("amazonApiKey")) ?? (await waitFor(() => apiKey, 10_000))
    const page = await runInTab(tabId, amazonPageConfig, [!apiKey])
    const tld = page.host.match(tldPattern)?.[1]
    if (!tld) throw new ProviderError(`Unsupported Amazon Music storefront ${page.host}`, "unsupported")
    if (tld !== region) await setLocal({amazonRegion: tld})
    if (!page.signedIn || !page.config) throw new ProviderError("Not signed in to Amazon Music", "auth")
    if (!apiKey && page.key) {
        apiKey = page.key
        await setLocal({amazonApiKey: apiKey})
    }
    if (!apiKey) throw new ProviderError("Could not find the Amazon Music web API key, reload music.amazon.com and try again")
    const c = page.config
    const headers = {
        "content-type": "application/json",
        accept: "application/graphql-response+json, application/json",
        "x-api-key": apiKey,
        "x-amzn-device-id": c.deviceId,
        "x-amzn-device-type": c.deviceType,
        "music-territory": c.musicTerritory,
        "x-amzn-session-id": c.sessionId,
        "csrf-rnd": c.csrfRnd,
        "csrf-token": c.csrfToken,
        "csrf-ts": c.csrfTs
    }
    return {tabId, tld, endpoint: `https://gql.music.amazon.${tld}/`, headers}
}

// Run a GraphQL query or mutation and return its data, mapping errors to result codes.
async function gql(s: AmazonSession, query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await runInTab(s.tabId, pageFetch, [s.endpoint, {method: "POST", headers: s.headers, body: JSON.stringify({query, variables}), credentials: "include"}])
    if (res.status === 429) throw new ProviderError("Amazon Music rate limit reached", "rate_limit")
    if (res.status === 401 || res.status === 403) {
        // The cached API key may have been rotated: drop it so it is captured again.
        apiKey = undefined
        await chrome.storage.local.remove("amazonApiKey")
        throw new ProviderError(`Amazon Music denied access (HTTP ${res.status})`, "auth")
    }
    let body: any
    try {
        body = JSON.parse(res.text)
    } catch {
        throw new ProviderError(`Amazon Music request failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`)
    }
    if (body?.errors?.length) {
        const text = body.errors.map((e: any) => [e?.message, e?.code, e?.extensions?.code, e?.extensions?.errorType].filter(Boolean).join(" ")).join("; ")
        const code = /DAILY_CHANGE_LIMIT_REACHED|THROTTL|TOO_MANY/i.test(text) ? "rate_limit" : /UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN|\b40[13]\b/i.test(text) ? "auth" : /NOT_FOUND/i.test(text) ? "not_found" : "failed"
        throw new ProviderError(`Amazon Music: ${text}`.slice(0, 500), code)
    }
    if (res.status >= 400) throw new ProviderError(`Amazon Music request failed (HTTP ${res.status})`)
    return body?.data
}

// Convert a GraphQL track node to an extension track; non-track nodes are unavailable.
function toTrack(node: any, itemId?: string): ExtensionTrack {
    if (node?.__typename !== "Track") return {itemId: itemId ?? node?.id ?? "", trackId: node?.id ?? "", title: "", artists: [], unavailable: true}
    const artists = (node.contributingArtists?.edges ?? []).map((e: any) => e?.node?.name).filter(Boolean)
    const durationMs = typeof node.duration === "number" ? Math.round(node.duration * 1000) : undefined
    return {itemId: itemId ?? node.id, trackId: node.id, title: node.title ?? "", artists, album: node.album?.title || undefined, durationMs, isrc: node.isrc || undefined, url: node.url || undefined}
}

// Remember track durations so getTrackDurations rarely needs extra requests.
async function cacheDurations(tracks: ExtensionTrack[]): Promise<void> {
    const values = Object.fromEntries(tracks.filter((t) => t.durationMs).map((t) => [`am:${t.trackId}`, t.durationMs]))
    if (Object.keys(values).length) await setLocal(values)
}

// Read all items of a playlist, with its URI.
async function readPlaylist(s: AmazonSession, id: string): Promise<{uri: string; tracks: ExtensionTrack[]}> {
    const tracks: ExtensionTrack[] = []
    let uri = ""
    let limit = 100
    let cursor: string | null = null
    while (true) {
        let data: any
        try {
            data = await gql(s, itemsQuery, {id, limit, cursor})
        } catch (err) {
            // Fall back to smaller pages if the server rejects 100.
            if (limit === 100 && err instanceof ProviderError && err.code === "failed") {
                limit = 50
                continue
            }
            throw err
        }
        const playlist = data?.playlist
        if (!playlist) throw new ProviderError(`Amazon Music playlist ${id} not found`, "not_found")
        uri = playlist.uri
        for (const edge of playlist.tracks?.edges ?? []) tracks.push(toTrack(edge?.node, edge?.itemId))
        const info = playlist.tracks?.pageInfo
        if (!info?.hasNextPage || !info.token || info.token === cursor) break
        cursor = info.token
    }
    await cacheDurations(tracks)
    return {uri, tracks}
}

// Playlists query, optionally with the description field (not verified live).
function playlistsQuery(withDescription: boolean): string {
    return `query($limit: Float!, $cursor: String) { user { playlists(limit: $limit, cursor: $cursor, sortBy: "LAST_MODIFIED_DATE") { edges { node { __typename ... on Playlist { id title trackCount ${withDescription ? "description " : ""}capabilities { appendTracks { isAllowed } removeTracks { isAllowed } } } } } pageInfo { hasNextPage token } } } }`
}

export const amazon: ProviderConnector = {
    provider: "amazon",
    name: "Amazon Music",
    loginUrl: "https://music.amazon.com/",
    tabPatterns: amazonTabPatterns,

    // Detect the signed-in Amazon Music user.
    async detectAccount() {
        try {
            const s = await session()
            const user = (await gql(s, "query { user { id name } }", {}))?.user
            return user?.id ? {provider: "amazon", accountId: user.id, displayName: user.name || user.id, region: s.tld} : null
        } catch (err) {
            if (err instanceof ProviderError && err.code === "auth") return null
            throw err
        }
    },

    // List the user's playlists, optionally only those that accept new tracks.
    async listPlaylists({writableOnly}) {
        const s = await session()
        const playlists: ExtensionPlaylist[] = []
        let withDescription = true
        let cursor: string | null = null
        while (true) {
            let data: any
            try {
                data = await gql(s, playlistsQuery(withDescription), {limit: 50, cursor})
            } catch (err) {
                if (withDescription && err instanceof ProviderError && err.code === "failed") {
                    withDescription = false
                    continue
                }
                throw err
            }
            const page = data?.user?.playlists
            if (!page) throw new ProviderError("Not signed in to Amazon Music", "auth")
            for (const edge of page.edges ?? []) {
                const node = edge?.node
                if (node?.__typename !== "Playlist" || (writableOnly && !node.capabilities?.appendTracks?.isAllowed)) continue
                playlists.push({id: node.id, name: node.title ?? "", description: node.description || undefined, itemCount: node.trackCount ?? undefined})
            }
            if (!page.pageInfo?.hasNextPage || !page.pageInfo.token || page.pageInfo.token === cursor) break
            cursor = page.pageInfo.token
        }
        return playlists
    },

    // Create a private playlist.
    async createPlaylist({name, description}) {
        const s = await session()
        const data = await gql(s, "mutation($title: String!, $description: String, $visibility: String) { createPlaylist(title: $title, description: $description, visibility: $visibility) { id title trackCount } }", {
            title: name,
            description: description ?? "",
            visibility: "PRIVATE"
        })
        const playlist = data?.createPlaylist
        if (!playlist?.id) throw new ProviderError("Amazon Music did not return the created playlist")
        return {id: playlist.id, name: playlist.title ?? name, description, itemCount: playlist.trackCount ?? 0}
    },

    // Delete a playlist.
    async deletePlaylist({playlistId}) {
        const s = await session()
        const data = await gql(s, "mutation($id: String!) { deletePlaylist(id: $id) { id isDeleted } }", {id: playlistId})
        if (!data?.deletePlaylist) throw new ProviderError(`Amazon Music playlist ${playlistId} not found`, "not_found")
        return null
    },

    // Read all items of a playlist.
    async getPlaylistItems({playlistId}) {
        return (await readPlaylist(await session(), playlistId)).tracks
    },

    // Search tracks by title and artist (Amazon search does not match raw ISRCs).
    async searchTrackCandidates({track}) {
        const s = await session()
        const data = await gql(s, searchQuery, {searchText: searchText(track), specifications: [{label: "TopResults", types: ["track"], limit: 20}]})
        const results = [data?.specificationSearch?.result ?? []].flat()
        const tracks = results
            .flatMap((r: any) => r?.edges ?? [])
            .filter((e: any) => e?.node?.__typename === "Track")
            .map((e: any) => toTrack(e.node))
        const unique = [...new Map(tracks.map((t: ExtensionTrack) => [t.trackId, t])).values()]
        await cacheDurations(unique)
        return unique
    },

    // Durations from the cache, falling back to one track query per ID.
    async getTrackDurations({trackIds}) {
        const cached = await chrome.storage.local.get(trackIds.map((id) => `am:${id}`))
        const durations: Record<string, number> = {}
        const missing = trackIds.filter((id) => {
            const ms = cached[`am:${id}`]
            if (typeof ms === "number") durations[id] = ms
            return typeof ms !== "number"
        })
        if (!missing.length) return durations
        const s = await session()
        await mapLimit(missing, 4, async (id) => {
            try {
                // Unverified: the track(id) query was not tested live.
                const track = (await gql(s, "query($id: String!) { track(id: $id) { id duration } }", {id}))?.track
                if (typeof track?.duration === "number") durations[id] = Math.round(track.duration * 1000)
            } catch {}
        })
        return durations
    },

    // Append tracks to a playlist. Item IDs are not returned by the mutation.
    async addTracks({playlistId, trackIds}) {
        const s = await session()
        const data = await gql(s, "mutation($id: String!, $trackIds: [String]!, $rejectDuplicateTracks: Boolean) { appendTracks(playlistId: $id, trackIds: $trackIds, rejectDuplicateTracks: $rejectDuplicateTracks) { id trackCount } }", {
            id: playlistId,
            trackIds,
            rejectDuplicateTracks: false
        })
        if (!data?.appendTracks) throw new ProviderError(`Amazon Music playlist ${playlistId} not found`, "not_found")
        return trackIds.map((id) => ({providerTrackId: id}))
    },

    // Remove playlist entries by item ID; entries that are already gone are ignored.
    async removePlaylistItems({playlistId, itemIds}) {
        const s = await session()
        const {uri, tracks} = await readPlaylist(s, playlistId)
        const wanted = new Set(itemIds)
        const items = tracks.flatMap((t, index) => (wanted.has(t.itemId) ? [{item: {itemId: t.itemId, possibleIndex: index}}] : []))
        if (!items.length) return null
        await gql(s, "mutation($input: BatchUpdatePlaylistInput!) { batchUpdatePlaylist(input: $input) { playlist { id trackCount } } }", {input: {id: uri, updates: [{removeItems: {items}}]}})
        return null
    }
}
