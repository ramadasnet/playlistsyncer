// Adapt Apple Music library playlists and catalog songs to the provider-neutral sync contract.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {isMissingPlaylistError, providerFetch} from "./http"
import {catalogSearchQuery, findBestTrackMatch} from "./matching"
import {trackIdsForProvider} from "./track-ids"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiOrigin = "https://api.music.apple.com"
const apiBase = `${apiOrigin}/v1`
const pageLimit = "100"
const lookupBatchSize = 100
const additionBatchSize = 50
const searchLimit = "10"
const artworkSize = "300"
const catalogPrefix = "apple:song:"
const libraryPrefix = "apple:library-song:"
// Apple notes that a new playlist can take a moment to appear in the library.
const newPlaylistGraceMs = 2 * 60 * 1000

interface AppleResource<A> {
    id: string
    type: string
    attributes?: A
    relationships?: {
        artists?: {data?: AppleResource<{name?: string}>[]}
        tracks?: {data?: AppleResource<SongAttributes>[]; next?: string}
    }
}

interface ApplePage<T> {
    data?: T[]
    next?: string
}

interface SongAttributes {
    name?: string
    artistName?: string
    albumName?: string
    durationInMillis?: number
    isrc?: string
    url?: string
    artwork?: {url?: string}
    playParams?: {id?: string; kind?: string; catalogId?: string}
}

interface PlaylistAttributes {
    name?: string
    canEdit?: boolean
    description?: {standard?: string; short?: string}
    artwork?: {url?: string}
}

type AppleSong = AppleResource<SongAttributes>
type ApplePlaylist = AppleResource<PlaylistAttributes>

const recentlyCreatedPlaylists = new Map<string, number>()
const storefronts = new Map<string, string>()

// Keep the query of the first request on later pages, since Apple's next links can drop the limit.
function nextPageUrl(next: string, firstUrl: string): string {
    const url = new URL(next, apiOrigin)
    for (const [name, value] of new URL(firstUrl).searchParams) {
        if (name !== "offset" && !url.searchParams.has(name)) {
            url.searchParams.set(name, value)
        }
    }
    return url.toString()
}

async function collectPages<T>(account: ProviderAccountDocument, url: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = url
    while (next) {
        const page: ApplePage<T> = await providerFetch(account, next)
        items.push(...(page.data || []))
        next = page.next ? nextPageUrl(page.next, url) : undefined
    }
    return items
}

function artworkUrl(artwork?: {url?: string}): string | undefined {
    return artwork?.url?.replace("{w}", artworkSize).replace("{h}", artworkSize) || undefined
}

// Apple joins credited artists as "A, B & C" when it has no artist resources to list.
function splitArtistName(name?: string): string[] {
    return (name || "")
        .split(/\s*,\s*|\s+&\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
}

function songArtists(song: AppleSong): string[] {
    const related = (song.relationships?.artists?.data || []).flatMap((artist) => {
        const name = artist.attributes?.name?.trim()
        return name ? [name] : []
    })
    return related.length ? related : splitArtistName(song.attributes?.artistName)
}

function mapSong(song: AppleSong, trackId: string, itemId = trackId): ProviderTrack {
    const attributes = song.attributes || {}
    const url = attributes.url?.trim()
    return {
        itemId,
        trackId,
        title: attributes.name?.trim() || "Untitled track",
        artists: songArtists(song),
        album: attributes.albumName?.trim() || undefined,
        durationMs: attributes.durationInMillis && attributes.durationInMillis > 0 ? attributes.durationInMillis : undefined,
        isrc: attributes.isrc?.trim() || undefined,
        imageUrl: artworkUrl(attributes.artwork),
        ...(url?.startsWith("https://music.apple.com/") ? {url} : {})
    }
}

function mapCatalogSong(song: AppleSong): ProviderTrack {
    return mapSong(song, `${catalogPrefix}${song.id}`)
}

function asPlaylist(playlist: ApplePlaylist): ProviderPlaylist {
    const attributes = playlist.attributes || {}
    return {
        id: playlist.id,
        name: attributes.name?.trim() || `Untitled playlist (${playlist.id})`,
        description: attributes.description?.standard ?? attributes.description?.short ?? "",
        imageUrl: artworkUrl(attributes.artwork)
    }
}

// Request body identifier for a track: a catalog song, or a library-only song such as an upload.
function trackResource(trackId: string): {id: string; type: "songs" | "library-songs"} | undefined {
    if (trackId.startsWith(catalogPrefix)) return {id: trackId.slice(catalogPrefix.length), type: "songs"}
    if (trackId.startsWith(libraryPrefix)) return {id: trackId.slice(libraryPrefix.length), type: "library-songs"}
    return undefined
}

// Read the storefront (country catalog) of the account's Apple Music subscription.
export async function readAppleStorefront(account: ProviderAccountDocument): Promise<string> {
    const result = await providerFetch<ApplePage<{id: string}>>(account, `${apiBase}/me/storefront`)
    const storefront = result.data?.[0]?.id
    if (!storefront) {
        throw createError({statusCode: 502, statusMessage: "Apple Music did not return a storefront"})
    }
    return storefront
}

async function storefrontFor(account: ProviderAccountDocument): Promise<string> {
    if (account.storefront) {
        return account.storefront
    }
    const cacheKey = account._id?.toHexString() || account.externalAccountId
    const cached = storefronts.get(cacheKey)
    if (cached) {
        return cached
    }
    const storefront = await readAppleStorefront(account)
    storefronts.set(cacheKey, storefront)
    return storefront
}

// Load catalog songs, with their ISRC and artist resources, by catalog ID.
async function catalogSongs(account: ProviderAccountDocument, ids: string[]): Promise<Map<string, AppleSong>> {
    const songs = new Map<string, AppleSong>()
    if (!ids.length) {
        return songs
    }
    const storefront = encodeURIComponent(await storefrontFor(account))
    for (let index = 0; index < ids.length; index += lookupBatchSize) {
        const params = new URLSearchParams({ids: ids.slice(index, index + lookupBatchSize).join(","), include: "artists"})
        const result = await providerFetch<ApplePage<AppleSong>>(account, `${apiBase}/catalog/${storefront}/songs?${params.toString()}`)
        for (const song of result.data || []) {
            songs.set(song.id, song)
        }
    }
    return songs
}

// Read a playlist with its first page of tracks. An empty playlist still answers, unlike its tracks endpoint.
async function playlistEntries(account: ProviderAccountDocument, playlistId: string): Promise<AppleSong[]> {
    const url = `${apiBase}/me/library/playlists/${encodeURIComponent(playlistId)}?${new URLSearchParams({include: "tracks"}).toString()}`
    let document: ApplePage<ApplePlaylist>
    try {
        document = await providerFetch(account, url)
    } catch (error) {
        if (isMissingPlaylistError(error) && (recentlyCreatedPlaylists.get(playlistId) || 0) > Date.now()) {
            return []
        }
        throw error
    }
    const tracks = document.data?.[0]?.relationships?.tracks
    const entries = [...(tracks?.data || [])]
    if (tracks?.next) {
        entries.push(...(await collectPages<AppleSong>(account, nextPageUrl(tracks.next, `${apiBase}/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${pageLimit}`))))
    }
    return entries
}

// Apple Music adapter. The API can create playlists and append tracks, but cannot remove tracks or delete playlists.
export const appleAdapter: ProviderAdapter = {
    provider: "apple",
    appendOnly: true,
    async listPlaylists(account, options) {
        const playlists = await collectPages<ApplePlaylist>(account, `${apiBase}/me/library/playlists?limit=${pageLimit}`)
        // Playlists added from the Apple Music catalog are read-only.
        const visible = options?.writableOnly ? playlists.filter((playlist) => playlist.attributes?.canEdit === true) : playlists
        return visible.map(asPlaylist)
    },
    async createPlaylist(account, name, description) {
        const result = await providerFetch<ApplePage<ApplePlaylist>>(account, `${apiBase}/me/library/playlists`, {
            method: "POST",
            body: JSON.stringify({attributes: {name, description: description ?? "", isPublic: false}})
        })
        const playlist = result?.data?.[0]
        if (!playlist?.id) {
            throw createError({statusCode: 502, statusMessage: "Apple Music playlist creation returned an unexpected payload"})
        }
        recentlyCreatedPlaylists.set(playlist.id, Date.now() + newPlaylistGraceMs)
        return {...asPlaylist(playlist), name: playlist.attributes?.name?.trim() || name, itemCount: 0}
    },
    async deletePlaylist() {
        throw createError({statusCode: 501, statusMessage: "Apple Music does not let apps delete playlists"})
    },
    async getPlaylistItems(account, playlistId) {
        // Music videos cannot be matched to songs on other providers, so only songs are synchronized.
        const entries = (await playlistEntries(account, playlistId)).filter((entry) => entry.type === "library-songs")
        const catalogIds = [...new Set(entries.flatMap((entry) => (entry.attributes?.playParams?.catalogId ? [entry.attributes.playParams.catalogId] : [])))]
        const catalog = await catalogSongs(account, catalogIds)
        return entries.map((entry, index) => {
            const catalogId = entry.attributes?.playParams?.catalogId
            const trackId = catalogId ? `${catalogPrefix}${catalogId}` : `${libraryPrefix}${entry.id}`
            const song = catalogId ? catalog.get(catalogId) : undefined
            // Entries repeat the same song ID for duplicates, so the position keeps every occurrence distinct.
            return mapSong(song || entry, trackId, `${trackId}:${index}`)
        })
    },
    async searchTrackCandidates(account, track) {
        const storefront = encodeURIComponent(await storefrontFor(account))
        if (track.isrc) {
            const params = new URLSearchParams({"filter[isrc]": track.isrc, include: "artists"})
            const result = await providerFetch<ApplePage<AppleSong>>(account, `${apiBase}/catalog/${storefront}/songs?${params.toString()}`)
            return (result.data || []).map(mapCatalogSong)
        }
        const query = catalogSearchQuery("apple", track)
        if (!query) {
            return []
        }
        const params = new URLSearchParams({term: query, types: "songs", limit: searchLimit})
        const result = await providerFetch<{results?: {songs?: ApplePage<AppleSong>}}>(account, `${apiBase}/catalog/${storefront}/search?${params.toString()}`)
        return (result.results?.songs?.data || []).map(mapCatalogSong)
    },
    // Another release of a recording can carry a different ISRC, so a failed ISRC search retries by title and artist.
    async searchTrack(account, track) {
        const match = findBestTrackMatch(track, await this.searchTrackCandidates(account, track))
        return match || !track.isrc ? match : findBestTrackMatch(track, await this.searchTrackCandidates(account, {...track, isrc: undefined}))
    },
    async getTrackDurations(account, trackIds) {
        const durations = new Map<string, number>()
        const ids = trackIdsForProvider("apple", trackIds)
        const catalogIds = ids.filter((id) => id.startsWith(catalogPrefix)).map((id) => id.slice(catalogPrefix.length))
        for (const song of (await catalogSongs(account, catalogIds)).values()) {
            const mapped = mapCatalogSong(song)
            if (mapped.durationMs) durations.set(mapped.trackId, mapped.durationMs)
        }
        const libraryIds = ids.filter((id) => id.startsWith(libraryPrefix)).map((id) => id.slice(libraryPrefix.length))
        for (let index = 0; index < libraryIds.length; index += lookupBatchSize) {
            const params = new URLSearchParams({ids: libraryIds.slice(index, index + lookupBatchSize).join(",")})
            const result = await providerFetch<ApplePage<AppleSong>>(account, `${apiBase}/me/library/songs?${params.toString()}`)
            for (const song of result.data || []) {
                const mapped = mapSong(song, `${libraryPrefix}${song.id}`)
                if (mapped.durationMs) durations.set(mapped.trackId, mapped.durationMs)
            }
        }
        return durations
    },
    async addTracks(account, playlistId, trackIds, onAdded) {
        const additions = trackIds.flatMap((trackId) => {
            const resource = trackResource(trackId)
            return resource ? [{trackId, resource}] : []
        })
        for (let index = 0; index < additions.length; index += additionBatchSize) {
            const batch = additions.slice(index, index + additionBatchSize)
            await providerFetch(account, `${apiBase}/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
                method: "POST",
                body: JSON.stringify({data: batch.map((addition) => addition.resource)})
            })
            await onAdded?.(batch.map((addition) => ({providerTrackId: addition.trackId})))
        }
    },
    // The sync engine skips removals for append-only providers. This guards any other caller.
    async removePlaylistItems() {
        throw createError({statusCode: 501, statusMessage: "Apple Music does not let apps remove tracks from playlists"})
    }
}
