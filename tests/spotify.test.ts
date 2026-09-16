import {beforeEach, describe, expect, mock, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"

const providerFetch = mock(async (): Promise<unknown> => undefined)

mock.module("../server/domain/providers/http", () => ({providerFetch}))

const {spotifyAdapter} = await import("../server/domain/providers/spotify")
const {youtubeAdapter} = await import("../server/domain/providers/youtube")
const account = {provider: "spotify"} as ProviderAccountDocument

describe("Spotify provider", () => {
    beforeEach(() => providerFetch.mockReset())

    test("creates playlists for the current user", async () => {
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", description: ""})
        })
    })

    test("copies the source playlist description when creating", async () => {
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", description: "Late night mix", images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist", "Late night mix")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", description: "Late night mix"})
        })
    })

    test("truncates long source descriptions to Spotify's limit", async () => {
        const description = `${"a".repeat(300)}extra`
        providerFetch.mockResolvedValue({id: "playlist-id", name: "Source playlist", description: "a".repeat(300), images: []})

        await spotifyAdapter.createPlaylist(account, "Source playlist", description)

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.spotify.com/v1/me/playlists", {
            method: "POST",
            body: JSON.stringify({name: "Source playlist", description: "a".repeat(300)})
        })
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
