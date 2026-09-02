import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {providerFetch} from "./http"
import {findBestTrackMatch, searchableTitle} from "./matching"
import type {ProviderAdapter, ProviderPlaylist, ProviderTrack} from "./types"

const apiOrigin = "https://openapi.tidal.com"
const apiBase = `${apiOrigin}/v2`
const jsonApi = "application/vnd.api+json"
const mutationBatchSize = 20

interface JsonApiResource {
    id: string
    type: string
    attributes?: Record<string, unknown>
    relationships?: Record<string, {data?: JsonApiIdentifier | JsonApiIdentifier[] | null}>
    meta?: {itemId?: string}
}

interface JsonApiIdentifier {
    id: string
    type: string
    meta?: {itemId?: string}
}

interface JsonApiDocument<T = JsonApiResource | JsonApiResource[] | JsonApiIdentifier[]> {
    data?: T
    included?: JsonApiResource[]
    links?: {next?: string}
}

const jsonApiHeaders = (body?: boolean): HeadersInit => ({
    Accept: jsonApi,
    ...(body ? {"Content-Type": jsonApi} : {})
})

function tidalFetch<T>(account: ProviderAccountDocument, url: string, init: RequestInit = {}): Promise<T> {
    return providerFetch<T>(account, url, {
        ...init,
        headers: jsonApiHeaders(Boolean(init.body))
    })
}

function resolveTidalUrl(href: string): string {
    if (href.startsWith("https://") || href.startsWith("http://")) {
        return href
    }
    if (href.startsWith("/v2/")) {
        return `${apiOrigin}${href}`
    }
    return href.startsWith("/") ? `${apiBase}${href}` : `${apiBase}/${href}`
}

async function collectPages<T extends JsonApiIdentifier | JsonApiResource>(
    account: ProviderAccountDocument,
    url: string
): Promise<{items: T[]; included: JsonApiResource[]}> {
    const items: T[] = []
    const included: JsonApiResource[] = []
    let next: string | undefined = url
    while (next) {
        const page: JsonApiDocument<T[]> = await tidalFetch(account, next)
        items.push(...(page.data || []))
        included.push(...(page.included || []))
        next = page.links?.next ? resolveTidalUrl(page.links.next) : undefined
    }
    return {items, included}
}

function durationMs(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined
    }
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value)
    if (!match) {
        return undefined
    }
    const days = Number(match[1] || 0)
    const hours = Number(match[2] || 0)
    const minutes = Number(match[3] || 0)
    const seconds = Number(match[4] || 0)
    const milliseconds = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
    return milliseconds > 0 ? Math.round(milliseconds) : undefined
}

function relatedIds(resource: JsonApiResource, name: string): string[] {
    const data = resource.relationships?.[name]?.data
    if (!data) {
        return []
    }
    return (Array.isArray(data) ? data : [data]).map((identifier) => identifier.id)
}

function includedResource(included: JsonApiResource[], type: string, id: string): JsonApiResource | undefined {
    return included.find((resource) => resource.type === type && resource.id === id)
}

function attributeString(resource: JsonApiResource | undefined, name: string): string | undefined {
    const value = resource?.attributes?.[name]
    return typeof value === "string" && value ? value : undefined
}

function mapTrack(resource: JsonApiResource, included: JsonApiResource[], itemId: string): ProviderTrack {
    return {
        itemId,
        trackId: resource.id,
        title: attributeString(resource, "title") || "",
        artists: relatedIds(resource, "artists").flatMap((id) => {
            const name = attributeString(includedResource(included, "artists", id), "name")
            return name ? [name] : []
        }),
        album: relatedIds(resource, "albums")
            .map((id) => attributeString(includedResource(included, "albums", id), "title"))
            .find(Boolean),
        durationMs: durationMs(resource.attributes?.duration),
        isrc: attributeString(resource, "isrc")
    }
}

function playlistItemId(identifier: JsonApiIdentifier, index: number): string {
    return `${identifier.id}:${identifier.meta?.itemId || index}`
}

function parsePlaylistItemId(itemId: string): {id: string; itemId: string} | undefined {
    const separator = itemId.indexOf(":")
    if (separator <= 0 || separator === itemId.length - 1) {
        return undefined
    }
    return {id: itemId.slice(0, separator), itemId: itemId.slice(separator + 1)}
}

function asPlaylist(resource: JsonApiResource): ProviderPlaylist {
    return {
        id: resource.id,
        name: attributeString(resource, "name") || "Untitled playlist",
        description: attributeString(resource, "description"),
        itemCount: typeof resource.attributes?.numberOfItems === "number" ? resource.attributes.numberOfItems : 0
    }
}

export const tidalAdapter: ProviderAdapter = {
    provider: "tidal",
    async listPlaylists(account) {
        const {items} = await collectPages<JsonApiResource>(
            account,
            `${apiBase}/playlists?${new URLSearchParams({"filter[owners.id]": "me"}).toString()}`
        )
        return items
            .filter((playlist) => !playlist.attributes?.playlistType || playlist.attributes.playlistType === "USER")
            .map(asPlaylist)
    },
    async createPlaylist(account, name) {
        const document = await tidalFetch<JsonApiDocument<JsonApiResource>>(account, `${apiBase}/playlists`, {
            method: "POST",
            body: JSON.stringify({
                data: {type: "playlists", attributes: {name, accessType: "UNLISTED"}}
            })
        })
        if (!document.data || Array.isArray(document.data)) {
            throw createError({
                statusCode: 502,
                statusMessage: "TIDAL playlist creation returned an unexpected payload"
            })
        }
        return asPlaylist(document.data)
    },
    async deletePlaylist(account, playlistId) {
        await tidalFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}`, {method: "DELETE"})
    },
    async getPlaylistItems(account, playlistId) {
        const include = "items,items.tracks:artists,items.tracks:albums"
        const {items, included} = await collectPages<JsonApiIdentifier>(
            account,
            `${apiBase}/playlists/${encodeURIComponent(playlistId)}/relationships/items?${new URLSearchParams({include}).toString()}`
        )
        return items.flatMap((identifier, index) => {
            if (identifier.type !== "tracks") {
                return []
            }
            const resource = includedResource(included, "tracks", identifier.id)
            return resource ? [mapTrack(resource, included, playlistItemId(identifier, index))] : []
        })
    },
    async searchTrack(account, track) {
        if (track.isrc) {
            const query = new URLSearchParams({
                "filter[isrc]": track.isrc,
                include: "artists,albums"
            })
            const result = await tidalFetch<JsonApiDocument<JsonApiResource[]>>(
                account,
                `${apiBase}/tracks?${query.toString()}`
            )
            return findBestTrackMatch(
                track,
                (result.data || []).map((candidate) => mapTrack(candidate, result.included || [], candidate.id))
            )
        }
        const query = [track.artists[0], searchableTitle(track.title)].filter(Boolean).join(" ").trim()
        if (!query) {
            return null
        }
        const params = new URLSearchParams({include: "tracks,tracks.artists,tracks.albums"})
        const result = await tidalFetch<JsonApiDocument<JsonApiIdentifier[]>>(
            account,
            `${apiBase}/searchResults/${encodeURIComponent(query)}/relationships/tracks?${params.toString()}`
        )
        const included = result.included || []
        const candidates = (result.data || []).flatMap((identifier) => {
            const resource = includedResource(included, "tracks", identifier.id)
            return resource ? [mapTrack(resource, included, resource.id)] : []
        })
        return findBestTrackMatch(track, candidates)
    },
    async addTracks(account, playlistId, trackIds, onAdded) {
        for (let index = 0; index < trackIds.length; index += mutationBatchSize) {
            const batch = trackIds.slice(index, index + mutationBatchSize)
            await tidalFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/relationships/items`, {
                method: "POST",
                body: JSON.stringify({data: batch.map((id) => ({id, type: "tracks"}))})
            })
            await onAdded?.(batch.map((providerTrackId) => ({providerTrackId})))
        }
    },
    async removePlaylistItems(account, playlistId, itemIds, onRemoved) {
        const removals = itemIds.flatMap((itemId) => {
            const parsed = parsePlaylistItemId(itemId)
            return parsed ? [{item: {id: parsed.id, type: "tracks", meta: {itemId: parsed.itemId}}, itemId}] : []
        })
        for (let index = 0; index < removals.length; index += mutationBatchSize) {
            const batch = removals.slice(index, index + mutationBatchSize)
            await tidalFetch(account, `${apiBase}/playlists/${encodeURIComponent(playlistId)}/relationships/items`, {
                method: "DELETE",
                body: JSON.stringify({data: batch.map((removal) => removal.item)})
            })
            await onRemoved?.(batch.map((removal) => removal.itemId))
        }
    }
}
