import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"
import * as http from "../server/domain/providers/http"
import {tidalAdapter} from "../server/domain/providers/tidal"

const providerFetch = mock(async (): Promise<unknown> => undefined)

// A spy instead of mock.module, which would replace providerFetch for every later test file.
const providerFetchSpy = spyOn(http, "providerFetch").mockImplementation(providerFetch as unknown as typeof http.providerFetch)
afterAll(() => providerFetchSpy.mockRestore())

const account = {provider: "tidal"} as ProviderAccountDocument

function jsonApiHeaders(body = false) {
    return {
        Accept: "application/vnd.api+json",
        ...(body ? {"Content-Type": "application/vnd.api+json"} : {})
    }
}

describe("TIDAL provider", () => {
    beforeEach(() => providerFetch.mockReset())

    test("lists user-owned playlists from the JSON:API collection", async () => {
        providerFetch.mockResolvedValueOnce({
            data: [
                {
                    id: "owned-id",
                    type: "playlists",
                    attributes: {name: "Owned", numberOfItems: 3, playlistType: "USER"}
                },
                {id: "mix-id", type: "playlists", attributes: {name: "Mix", numberOfItems: 12, playlistType: "MIX"}}
            ],
            links: {}
        })

        const playlists = await tidalAdapter.listPlaylists(account)

        expect(providerFetch).toHaveBeenCalledWith(account, "https://openapi.tidal.com/v2/playlists?filter%5Bowners.id%5D=me", expect.objectContaining({headers: jsonApiHeaders()}))
        expect(playlists).toEqual([{id: "owned-id", name: "Owned", description: "", itemCount: 3}])
    })

    test("creates unlisted playlists for the current user", async () => {
        providerFetch.mockResolvedValue({
            data: {id: "playlist-id", type: "playlists", attributes: {name: "Source playlist", numberOfItems: 0}}
        })

        const playlist = await tidalAdapter.createPlaylist(account, "Source playlist")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://openapi.tidal.com/v2/playlists", {
            method: "POST",
            headers: jsonApiHeaders(true),
            body: JSON.stringify({
                data: {type: "playlists", attributes: {name: "Source playlist", description: "", accessType: "UNLISTED"}}
            })
        })
        expect(playlist).toEqual({
            id: "playlist-id",
            name: "Source playlist",
            description: "",
            itemCount: 0
        })

        await tidalAdapter.deletePlaylist(account, "playlist-id")
        expect(providerFetch).toHaveBeenLastCalledWith(account, "https://openapi.tidal.com/v2/playlists/playlist-id", {
            method: "DELETE",
            headers: jsonApiHeaders()
        })
    })

    test("reads playlist tracks and skips videos", async () => {
        providerFetch.mockResolvedValue({
            data: [
                {id: "track-id", type: "tracks", meta: {itemId: "item-1"}},
                {id: "video-id", type: "videos", meta: {itemId: "item-2"}}
            ],
            included: [
                {
                    id: "track-id",
                    type: "tracks",
                    attributes: {title: "Track", duration: "PT2M58S", isrc: "USRC17607839"},
                    relationships: {
                        artists: {data: [{id: "artist-id", type: "artists"}]},
                        albums: {data: [{id: "album-id", type: "albums"}]}
                    }
                },
                {id: "artist-id", type: "artists", attributes: {name: "Artist"}},
                {id: "album-id", type: "albums", attributes: {title: "Album"}}
            ],
            links: {}
        })

        const tracks = await tidalAdapter.getPlaylistItems(account, "playlist-id")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://openapi.tidal.com/v2/playlists/playlist-id/relationships/items?include=items%2Citems.tracks%3Aartists%2Citems.tracks%3Aalbums", expect.objectContaining({headers: jsonApiHeaders()}))
        expect(tracks).toHaveLength(1)
        expect(tracks[0]).toEqual({
            itemId: "track-id:item-1",
            trackId: "track-id",
            title: "Track",
            artists: ["Artist"],
            album: "Album",
            durationMs: 178000,
            isrc: "USRC17607839"
        })
    })

    test("searches the catalog by ISRC before falling back to text search", async () => {
        providerFetch.mockResolvedValueOnce({
            data: [
                {
                    id: "match-id",
                    type: "tracks",
                    attributes: {title: "Track", isrc: "USRC17607839"},
                    relationships: {artists: {data: [{id: "artist-id", type: "artists"}]}}
                }
            ],
            included: [{id: "artist-id", type: "artists", attributes: {name: "Artist"}}]
        })

        const isrcMatch = await tidalAdapter.searchTrack(account, {
            itemId: "source",
            trackId: "source",
            title: "Track",
            artists: ["Artist"],
            isrc: "USRC17607839"
        })

        expect(providerFetch).toHaveBeenCalledWith(account, "https://openapi.tidal.com/v2/tracks?filter%5Bisrc%5D=USRC17607839&include=artists%2Calbums", expect.objectContaining({headers: jsonApiHeaders()}))
        expect(isrcMatch?.trackId).toBe("match-id")

        providerFetch.mockResolvedValueOnce({
            data: [{id: "search-id", type: "tracks"}],
            included: [
                {
                    id: "search-id",
                    type: "tracks",
                    attributes: {title: "Track"},
                    relationships: {artists: {data: [{id: "artist-id", type: "artists"}]}}
                },
                {id: "artist-id", type: "artists", attributes: {name: "Artist"}}
            ]
        })

        const textMatch = await tidalAdapter.searchTrack(account, {
            itemId: "source",
            trackId: "source",
            title: "Track",
            artists: ["Artist"]
        })

        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://openapi.tidal.com/v2/searchResults/Artist%20Track/relationships/tracks?include=tracks%2Ctracks.artists%2Ctracks.albums", expect.objectContaining({headers: jsonApiHeaders()}))
        expect(textMatch?.trackId).toBe("search-id")
    })

    test("searches by title when the ISRC finds no release of the recording", async () => {
        providerFetch.mockResolvedValueOnce({data: [], included: []})
        providerFetch.mockResolvedValueOnce({
            data: [{id: "title-id", type: "tracks"}],
            included: [
                {id: "title-id", type: "tracks", attributes: {title: "Track", isrc: "GBOTHER0001"}, relationships: {artists: {data: [{id: "artist-id", type: "artists"}]}}},
                {id: "artist-id", type: "artists", attributes: {name: "Artist"}}
            ]
        })

        const match = await tidalAdapter.searchTrack(account, {itemId: "source", trackId: "source", title: "Track", artists: ["Artist"], isrc: "USRC17607839"})

        expect(providerFetch).toHaveBeenCalledTimes(2)
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://openapi.tidal.com/v2/searchResults/Artist%20Track/relationships/tracks?include=tracks%2Ctracks.artists%2Ctracks.albums", expect.objectContaining({headers: jsonApiHeaders()}))
        expect(match?.trackId).toBe("title-id")
    })

    test("keeps a playlist entry whose track TIDAL no longer returns as an unavailable placeholder", async () => {
        providerFetch.mockResolvedValue({data: [{id: "gone-id", type: "tracks", meta: {itemId: "item-9"}}], included: [], links: {}})

        expect(await tidalAdapter.getPlaylistItems(account, "playlist-id")).toEqual([{itemId: "gone-id:item-9", trackId: "gone-id", title: "", artists: [], unavailable: true}])
    })

    test("adds and removes playlist items in JSON:API batches of 20", async () => {
        const onAdded = mock(async () => undefined)
        const onRemoved = mock(async () => undefined)
        const trackIds = Array.from({length: 21}, (_, index) => `track-${index}`)

        await tidalAdapter.addTracks(account, "playlist-id", trackIds, onAdded)
        await tidalAdapter.removePlaylistItems(account, "playlist-id", ["track-id:item-1"], onRemoved)

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, "https://openapi.tidal.com/v2/playlists/playlist-id/relationships/items", {
            method: "POST",
            headers: jsonApiHeaders(true),
            body: JSON.stringify({
                data: trackIds.slice(0, 20).map((id) => ({id, type: "tracks"}))
            })
        })
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://openapi.tidal.com/v2/playlists/playlist-id/relationships/items", {
            method: "POST",
            headers: jsonApiHeaders(true),
            body: JSON.stringify({
                data: [{id: "track-20", type: "tracks"}]
            })
        })
        expect(providerFetch).toHaveBeenNthCalledWith(3, account, "https://openapi.tidal.com/v2/playlists/playlist-id/relationships/items", {
            method: "DELETE",
            headers: jsonApiHeaders(true),
            body: JSON.stringify({
                data: [{id: "track-id", type: "tracks", meta: {itemId: "item-1"}}]
            })
        })
        expect(onAdded).toHaveBeenNthCalledWith(
            1,
            trackIds.slice(0, 20).map((providerTrackId) => ({providerTrackId}))
        )
        expect(onRemoved).toHaveBeenCalledWith(["track-id:item-1"])
    })

    test("does not report a mutation when the provider request fails", async () => {
        const onAdded = mock(async () => undefined)
        providerFetch.mockRejectedValue(new Error("Provider failed"))

        await expect(tidalAdapter.addTracks(account, "playlist-id", ["track-id"], onAdded)).rejects.toThrow("Provider failed")

        expect(onAdded).not.toHaveBeenCalled()
    })
})
