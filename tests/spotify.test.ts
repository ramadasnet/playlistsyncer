import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"
import * as http from "../server/domain/providers/http"
import {spotifyAdapter} from "../server/domain/providers/spotify"
import {youtubeAdapter} from "../server/domain/providers/youtube"

const providerFetch = mock(async (): Promise<unknown> => undefined)

// A spy instead of mock.module, which would replace providerFetch for every later test file.
const providerFetchSpy = spyOn(http, "providerFetch").mockImplementation(providerFetch as unknown as typeof http.providerFetch)
afterAll(() => providerFetchSpy.mockRestore())

const account = {provider: "spotify"} as ProviderAccountDocument

describe("Spotify provider", () => {
    beforeEach(() => providerFetch.mockReset())

    test("creates private playlists for the current user", async () => {
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", public: false, description: ""})
        })
    })

    test("copies the source playlist description when creating", async () => {
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", description: "Late night mix", images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist", "Late night mix")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", public: false, description: "Late night mix"})
        })
    })

    test("truncates long source descriptions to Spotify's limit", async () => {
        const description = `${"a".repeat(300)}extra`
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", description: "a".repeat(300), images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist", description)

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", public: false, description: "a".repeat(300)})
        })
    })

    test("lists every playlist, including followed ones, for a source sync", async () => {
        providerFetch.mockResolvedValueOnce({
            items: [
                {id: "playlist-items", name: "Items playlist", description: null, images: [], items: {total: 37}, owner: {id: "me"}},
                {id: "playlist-followed", name: "Followed", images: [], owner: {id: "friend"}},
                {id: "playlist-editorial", name: "Today's Top Hits", images: [], owner: {id: "spotify"}}
            ],
            next: null
        })

        const playlists = await spotifyAdapter.listPlaylists(account)

        expect(providerFetch).toHaveBeenCalledTimes(1)
        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists?limit=50")
        expect(playlists.map((playlist) => playlist.id)).toEqual(["playlist-items", "playlist-followed", "playlist-editorial"])
        expect(playlists[0]).toMatchObject({name: "Items playlist", description: "", itemCount: 37})
    })

    test("lists only owned and collaborative playlists when the caller will write", async () => {
        providerFetch.mockResolvedValueOnce({
            items: [
                {id: "playlist-items", name: "Items playlist", description: null, images: [], items: {total: 37}, owner: {id: "me"}},
                {id: "playlist-tracks", name: "Tracks playlist", description: "", images: [], tracks: {total: 12}, owner: {id: "me"}},
                {id: "playlist-empty", images: [], owner: {id: "me"}},
                {id: "playlist-shared", name: "Shared", images: [], owner: {id: "friend"}, collaborative: true},
                {id: "playlist-followed", name: "Followed", images: [], owner: {id: "friend"}},
                {id: "playlist-editorial", name: "Today's Top Hits", images: [], owner: {id: "spotify"}}
            ],
            next: null
        })
        providerFetch.mockResolvedValueOnce({id: "me"})

        const playlists = await spotifyAdapter.listPlaylists(account, {writableOnly: true})

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, "https://api.spotify.com/v1/me/playlists?limit=50")
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://api.spotify.com/v1/me")
        expect(playlists).toEqual([
            {id: "playlist-items", name: "Items playlist", description: "", imageUrl: undefined, itemCount: 37},
            {id: "playlist-tracks", name: "Tracks playlist", description: "", imageUrl: undefined, itemCount: 12},
            {id: "playlist-empty", name: "Untitled playlist (playlist-empty)", description: "", imageUrl: undefined, itemCount: 0},
            {id: "playlist-shared", name: "Shared", description: "", imageUrl: undefined, itemCount: 0}
        ])
    })

    test("searches by title when the ISRC finds no release of the recording", async () => {
        const candidate = {id: "title", uri: "spotify:track:title", name: "Song", artists: [{name: "Artist"}], external_ids: {isrc: "GBOTHER0001"}}
        providerFetch.mockResolvedValueOnce({tracks: {items: []}})
        providerFetch.mockResolvedValueOnce({tracks: {items: [candidate]}})

        const match = await spotifyAdapter.searchTrack(account, {itemId: "source", trackId: "source", title: "Song", artists: ["Artist"], isrc: "USRC17607839"})

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, "https://api.spotify.com/v1/search?type=track&limit=10&q=isrc%3AUSRC17607839")
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, `https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent("track:Song artist:Artist")}`)
        expect(match?.trackId).toBe("spotify:track:title")
    })

    test("gives unnamed YouTube playlists a unique fallback name", async () => {
        const youtubeAccount = {provider: "youtube"} as ProviderAccountDocument
        providerFetch.mockResolvedValue({
            items: [
                {id: "yt-named", snippet: {title: "Named playlist"}, contentDetails: {itemCount: 4}},
                {id: "yt-empty", snippet: {}, contentDetails: {}}
            ]
        })

        const playlists = await youtubeAdapter.listPlaylists(youtubeAccount)

        expect(playlists).toEqual([
            {id: "yt-named", name: "Named playlist", description: "", imageUrl: undefined, itemCount: 4},
            {id: "yt-empty", name: "Untitled playlist (yt-empty)", description: "", imageUrl: undefined, itemCount: 0}
        ])
    })

    test("reads playlist items from the current endpoint", async () => {
        providerFetch.mockResolvedValue({
            items: [
                {
                    item: {
                        id: "track-id",
                        uri: "spotify:track:track-id",
                        name: "Track",
                        artists: [{name: "Artist"}]
                    }
                }
            ],
            next: null
        })

        const tracks = await spotifyAdapter.getPlaylistItems(account, "playlist-id")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/playlists/playlist-id/items?limit=50")
        expect(tracks).toHaveLength(1)
        expect(tracks[0]?.trackId).toBe("spotify:track:track-id")
    })

    test("adds and removes playlist items through the current endpoint", async () => {
        const onAdded = mock(async () => undefined)
        const onRemoved = mock(async () => undefined)

        await spotifyAdapter.addTracks(account, "playlist-id", ["spotify:track:track-id"], onAdded)
        providerFetch.mockResolvedValueOnce({
            items: [{item: {uri: "spotify:track:track-id"}}],
            next: null
        })
        providerFetch.mockResolvedValueOnce({snapshot_id: "snapshot-1"})
        await spotifyAdapter.removePlaylistItems(account, "playlist-id", ["spotify:track:track-id:0"], onRemoved)

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, "https://api.spotify.com/v1/playlists/playlist-id/items", {method: "POST", body: JSON.stringify({uris: ["spotify:track:track-id"]})})
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://api.spotify.com/v1/playlists/playlist-id/items?limit=50")
        expect(providerFetch).toHaveBeenNthCalledWith(3, account, "https://api.spotify.com/v1/playlists/playlist-id?fields=snapshot_id")
        expect(providerFetch).toHaveBeenNthCalledWith(4, account, "https://api.spotify.com/v1/playlists/playlist-id/items", {
            method: "DELETE",
            body: JSON.stringify({
                items: [{uri: "spotify:track:track-id", positions: [0]}],
                snapshot_id: "snapshot-1"
            })
        })
        expect(onAdded).toHaveBeenCalledWith([{providerTrackId: "spotify:track:track-id"}])
        expect(onRemoved).toHaveBeenCalledWith(["spotify:track:track-id:0"])
    })

    test("re-resolves removal positions against the current snapshot", async () => {
        const onRemoved = mock(async () => undefined)

        providerFetch.mockResolvedValueOnce({
            items: [{item: {uri: "spotify:track:track-id"}}, {item: null}, {item: {uri: "spotify:track:track-id"}}],
            next: null
        })
        providerFetch.mockResolvedValueOnce({snapshot_id: "snapshot-1"})
        await spotifyAdapter.removePlaylistItems(account, "playlist-id", ["spotify:track:track-id:0"], onRemoved)

        expect(providerFetch).toHaveBeenNthCalledWith(3, account, "https://api.spotify.com/v1/playlists/playlist-id/items", {
            method: "DELETE",
            body: JSON.stringify({items: [{uri: "spotify:track:track-id", positions: [0]}], snapshot_id: "snapshot-1"})
        })
        expect(onRemoved).toHaveBeenCalledWith(["spotify:track:track-id:0"])
    })

    test("re-resolves removal positions across all playlist pages", async () => {
        const onRemoved = mock(async () => undefined)

        providerFetch.mockResolvedValueOnce({
            items: [{item: {uri: "spotify:track:track-id"}}],
            next: "https://api.spotify.com/v1/playlists/playlist-id/items?limit=50&offset=50"
        })
        providerFetch.mockResolvedValueOnce({
            items: [{item: {uri: "spotify:track:track-id"}}],
            next: null
        })
        providerFetch.mockResolvedValueOnce({snapshot_id: "snapshot-1"})
        await spotifyAdapter.removePlaylistItems(account, "playlist-id", ["spotify:track:track-id:0", "spotify:track:track-id:1"], onRemoved)

        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://api.spotify.com/v1/playlists/playlist-id/items?limit=50&offset=50")
        expect(providerFetch).toHaveBeenNthCalledWith(4, account, "https://api.spotify.com/v1/playlists/playlist-id/items", {
            method: "DELETE",
            body: JSON.stringify({items: [{uri: "spotify:track:track-id", positions: [0, 1]}], snapshot_id: "snapshot-1"})
        })
        expect(onRemoved).toHaveBeenCalledWith(["spotify:track:track-id:0", "spotify:track:track-id:1"])
    })

    test("refreshes positions and the snapshot for every deletion batch", async () => {
        const onRemoved = mock(async () => undefined)
        const uris = Array.from({length: 101}, (_, index) => `spotify:track:track-${index}`)
        const listing = {items: uris.map((uri) => ({item: {uri}})), next: null}

        providerFetch.mockResolvedValueOnce(listing)
        providerFetch.mockResolvedValueOnce({snapshot_id: "snapshot-1"})
        providerFetch.mockResolvedValueOnce(undefined)
        providerFetch.mockResolvedValueOnce(listing)
        providerFetch.mockResolvedValueOnce({snapshot_id: "snapshot-2"})
        providerFetch.mockResolvedValueOnce(undefined)
        await spotifyAdapter.removePlaylistItems(
            account,
            "playlist-id",
            uris.map((uri) => `${uri}:0`),
            onRemoved
        )

        const deletes = providerFetch.mock.calls.filter((call) => typeof call[1] === "string" && (call[2] as {method?: string})?.method === "DELETE")
        expect(deletes).toHaveLength(2)
        expect(JSON.parse((deletes[0]![2] as {body: string}).body)).toEqual({
            items: uris.slice(0, 100).map((uri, index) => ({uri, positions: [index]})),
            snapshot_id: "snapshot-1"
        })
        expect(JSON.parse((deletes[1]![2] as {body: string}).body)).toEqual({
            items: [{uri: uris[100], positions: [100]}],
            snapshot_id: "snapshot-2"
        })
        expect(onRemoved).toHaveBeenCalledTimes(2)
    })

    test("captures YouTube track and playlist item IDs after additions", async () => {
        const youtubeAccount = {provider: "youtube"} as ProviderAccountDocument
        const onAdded = mock(async () => undefined)
        providerFetch.mockResolvedValue({id: "playlist-item-id"})

        await youtubeAdapter.addTracks(youtubeAccount, "playlist-id", ["video-id"], onAdded)

        expect(onAdded).toHaveBeenCalledWith([{providerTrackId: "video-id", providerItemId: "playlist-item-id"}])
    })

    test("does not report a mutation when the provider request fails", async () => {
        const onAdded = mock(async () => undefined)
        providerFetch.mockRejectedValue(new Error("Provider failed"))

        await expect(spotifyAdapter.addTracks(account, "playlist-id", ["spotify:track:track-id"], onAdded)).rejects.toThrow("Provider failed")

        expect(onAdded).not.toHaveBeenCalled()
    })

    test("does not look up YouTube video IDs on the Spotify tracks endpoint", async () => {
        await expect(spotifyAdapter.getTrackDurations(account, ["dQw4w9WgXcQ", "123456789"])).resolves.toEqual(new Map())

        expect(providerFetch).not.toHaveBeenCalled()
    })
})
