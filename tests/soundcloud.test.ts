import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"
import * as http from "../server/domain/providers/http"
import {soundcloudAdapter} from "../server/domain/providers/soundcloud"

const providerFetch = mock(async (): Promise<unknown> => undefined)

// A spy instead of mock.module, which would replace providerFetch for every later test file.
const providerFetchSpy = spyOn(http, "providerFetch").mockImplementation(providerFetch as unknown as typeof http.providerFetch)
afterAll(() => providerFetchSpy.mockRestore())
;(globalThis as {createError?: (input: {statusCode: number; statusMessage: string}) => Error}).createError = (input) => Object.assign(new Error(input.statusMessage), input)

const account = {provider: "soundcloud"} as ProviderAccountDocument
const playlistId = "soundcloud:playlists:9"
const accept = {Accept: "application/json; charset=utf-8"}
const jsonHeaders = {...accept, "Content-Type": "application/json"}

describe("SoundCloud provider", () => {
    beforeEach(() => providerFetch.mockReset())

    test("lists user playlists and follows linked partitioning", async () => {
        providerFetch.mockResolvedValueOnce({
            collection: [
                {urn: "soundcloud:playlists:1", kind: "playlist", title: "Night drive", description: "Late", track_count: 4, artwork_url: "https://i1.sndcdn.com/artworks-large.jpg"},
                {urn: "soundcloud:system-playlists:artist-stations:2", kind: "system-playlist", title: "Station", track_count: 20},
                {kind: "playlist", title: "Missing id", track_count: 1}
            ],
            next_href: "https://api.soundcloud.com/me/playlists?cursor=2"
        })
        providerFetch.mockResolvedValueOnce({
            collection: [{urn: "soundcloud:playlists:3", kind: "playlist", title: "  ", track_count: 0}]
        })

        const playlists = await soundcloudAdapter.listPlaylists(account)

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, "https://api.soundcloud.com/me/playlists?show_tracks=false&linked_partitioning=true&limit=50", {headers: accept})
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, "https://api.soundcloud.com/me/playlists?cursor=2", {headers: accept})
        expect(playlists).toEqual([
            {
                id: "soundcloud:playlists:1",
                name: "Night drive",
                description: "Late",
                imageUrl: "https://i1.sndcdn.com/artworks-large.jpg",
                itemCount: 4
            },
            {
                id: "soundcloud:playlists:3",
                name: "Untitled playlist (soundcloud:playlists:3)",
                description: "",
                itemCount: 0
            }
        ])
    })

    test("creates private playlists and deletes them by URN", async () => {
        providerFetch.mockResolvedValueOnce({
            urn: "soundcloud:playlists:9",
            kind: "playlist",
            title: "Source playlist",
            description: "",
            track_count: 0
        })

        const playlist = await soundcloudAdapter.createPlaylist(account, "Source playlist", "Mirrored from Spotify")

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.soundcloud.com/playlists", {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({
                playlist: {
                    title: "Source playlist",
                    description: "Mirrored from Spotify",
                    sharing: "private",
                    tracks: []
                }
            })
        })
        expect(playlist).toEqual({
            id: playlistId,
            name: "Source playlist",
            description: "",
            itemCount: 0
        })

        await soundcloudAdapter.deletePlaylist(account, playlistId)
        expect(providerFetch).toHaveBeenLastCalledWith(account, `https://api.soundcloud.com/playlists/${playlistId}`, {
            method: "DELETE",
            headers: accept
        })
    })

    test("reads playlist tracks and keeps occurrence indexes", async () => {
        providerFetch.mockResolvedValue({
            collection: [
                {
                    urn: "soundcloud:tracks:11",
                    title: "Track",
                    duration: 178000,
                    isrc: "USRC17607839",
                    metadata_artist: "Artist",
                    release: "Album",
                    artwork_url: "https://i1.sndcdn.com/artworks-large.jpg"
                },
                {uri: "https://api.soundcloud.com/tracks/12", title: "Upload", user: {username: "Uploader"}}
            ]
        })

        const tracks = await soundcloudAdapter.getPlaylistItems(account, playlistId)

        expect(providerFetch).toHaveBeenCalledWith(account, `https://api.soundcloud.com/playlists/${playlistId}/tracks?linked_partitioning=true`, {headers: accept})
        expect(tracks).toEqual([
            {
                itemId: "soundcloud:tracks:11:0",
                trackId: "soundcloud:tracks:11",
                title: "Track",
                artists: ["Artist"],
                album: "Album",
                durationMs: 178000,
                isrc: "USRC17607839",
                imageUrl: "https://i1.sndcdn.com/artworks-large.jpg"
            },
            {
                itemId: "soundcloud:tracks:12:1",
                trackId: "soundcloud:tracks:12",
                title: "Upload",
                artists: ["Uploader"]
            }
        ])
    })

    test("searches by ISRC text before falling back to title and artist", async () => {
        providerFetch.mockResolvedValueOnce({
            collection: [{urn: "soundcloud:tracks:11", title: "Track", metadata_artist: "Artist", isrc: "USRC17607839"}]
        })

        const isrcMatch = await soundcloudAdapter.searchTrack(account, {
            itemId: "source",
            trackId: "source",
            title: "Track",
            artists: ["Artist"],
            isrc: "USRC17607839"
        })

        expect(providerFetch).toHaveBeenCalledTimes(1)
        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.soundcloud.com/tracks?q=USRC17607839&access=playable&limit=10&linked_partitioning=true", {headers: accept})
        expect(isrcMatch?.trackId).toBe("soundcloud:tracks:11")

        providerFetch.mockResolvedValueOnce({collection: [{urn: "soundcloud:tracks:12", title: "Other", isrc: "OTHER"}]})
        providerFetch.mockResolvedValueOnce({collection: [{urn: "soundcloud:tracks:13", title: "Track", metadata_artist: "Artist"}]})

        const textMatch = await soundcloudAdapter.searchTrack(account, {
            itemId: "source",
            trackId: "source",
            title: "Track",
            artists: ["Artist"],
            isrc: "USRC17607839"
        })

        expect(providerFetch).toHaveBeenNthCalledWith(3, account, "https://api.soundcloud.com/tracks?q=Artist+Track&access=playable&limit=10&linked_partitioning=true", {headers: accept})
        expect(textMatch?.trackId).toBe("soundcloud:tracks:13")
    })

    test("keeps only the first page of search candidates", async () => {
        providerFetch.mockResolvedValueOnce({
            collection: Array.from({length: 12}, (_, index) => ({
                urn: `soundcloud:tracks:${index + 1}`,
                title: "Track",
                metadata_artist: "Artist"
            })),
            next_href: "https://api.soundcloud.com/tracks?cursor=2"
        })

        const matches = await soundcloudAdapter.searchTrackCandidates(account, {
            itemId: "source",
            trackId: "source",
            title: "Track",
            artists: ["Artist"]
        })

        expect(providerFetch).toHaveBeenCalledTimes(1)
        expect(matches).toHaveLength(10)
        expect(matches[0]?.trackId).toBe("soundcloud:tracks:1")
        expect(matches[9]?.trackId).toBe("soundcloud:tracks:10")
    })

    test("replaces the full playlist when adding and removing tracks", async () => {
        const onAdded = mock(async () => undefined)
        const onRemoved = mock(async () => undefined)
        providerFetch.mockResolvedValueOnce({
            collection: [{urn: "soundcloud:tracks:11", title: "Existing", metadata_artist: "Artist"}]
        })
        providerFetch.mockResolvedValueOnce({urn: playlistId})

        await soundcloudAdapter.addTracks(account, playlistId, ["soundcloud:tracks:12", "not-a-soundcloud-id"], onAdded)

        expect(providerFetch).toHaveBeenNthCalledWith(2, account, `https://api.soundcloud.com/playlists/${playlistId}`, {
            method: "PUT",
            headers: jsonHeaders,
            body: JSON.stringify({
                playlist: {tracks: [{urn: "soundcloud:tracks:11"}, {urn: "soundcloud:tracks:12"}]}
            })
        })
        expect(onAdded).toHaveBeenCalledWith([{providerTrackId: "soundcloud:tracks:12"}])

        providerFetch.mockResolvedValueOnce({
            collection: [
                {urn: "soundcloud:tracks:11", title: "Existing"},
                {urn: "soundcloud:tracks:12", title: "Added"}
            ]
        })
        providerFetch.mockResolvedValueOnce({urn: playlistId})

        await soundcloudAdapter.removePlaylistItems(account, playlistId, ["soundcloud:tracks:11:0"], onRemoved)

        expect(providerFetch).toHaveBeenLastCalledWith(account, `https://api.soundcloud.com/playlists/${playlistId}`, {
            method: "PUT",
            headers: jsonHeaders,
            body: JSON.stringify({playlist: {tracks: [{urn: "soundcloud:tracks:12"}]}})
        })
        expect(onRemoved).toHaveBeenCalledWith(["soundcloud:tracks:11:0"])
    })

    test("removes only the requested copies when the same track is listed more than once", async () => {
        const onRemoved = mock(async () => undefined)
        providerFetch.mockResolvedValueOnce({
            collection: [
                {urn: "soundcloud:tracks:11", title: "First"},
                {urn: "soundcloud:tracks:12", title: "Other"},
                {urn: "soundcloud:tracks:11", title: "Second"}
            ]
        })
        providerFetch.mockResolvedValueOnce({urn: playlistId})

        await soundcloudAdapter.removePlaylistItems(account, playlistId, ["soundcloud:tracks:11:0"], onRemoved)

        expect(providerFetch).toHaveBeenLastCalledWith(account, `https://api.soundcloud.com/playlists/${playlistId}`, {
            method: "PUT",
            headers: jsonHeaders,
            body: JSON.stringify({
                playlist: {tracks: [{urn: "soundcloud:tracks:12"}, {urn: "soundcloud:tracks:11"}]}
            })
        })
        expect(onRemoved).toHaveBeenCalledWith(["soundcloud:tracks:11:0"])
    })

    test("does not report a mutation when the provider request fails", async () => {
        const onAdded = mock(async () => undefined)
        providerFetch.mockResolvedValueOnce({collection: []})
        providerFetch.mockRejectedValueOnce(new Error("Provider failed"))

        await expect(soundcloudAdapter.addTracks(account, playlistId, ["soundcloud:tracks:12"], onAdded)).rejects.toThrow("Provider failed")

        expect(onAdded).not.toHaveBeenCalled()
    })

    test("does not replace a playlist that contains an unmapped entry", async () => {
        const onAdded = mock(async () => undefined)
        const onRemoved = mock(async () => undefined)
        const unmappedPage = {
            collection: [{urn: "soundcloud:tracks:11", title: "Keep"}, {title: "Unmapped"}]
        }
        providerFetch.mockResolvedValueOnce(unmappedPage)

        const visible = await soundcloudAdapter.getPlaylistItems(account, playlistId)

        expect(visible.map((track) => track.trackId)).toEqual(["soundcloud:tracks:11"])

        providerFetch.mockResolvedValueOnce(unmappedPage)
        await expect(soundcloudAdapter.addTracks(account, playlistId, ["soundcloud:tracks:12"], onAdded)).rejects.toThrow("cannot be updated safely")

        providerFetch.mockResolvedValueOnce(unmappedPage)
        await expect(soundcloudAdapter.removePlaylistItems(account, playlistId, ["soundcloud:tracks:11:0"], onRemoved)).rejects.toThrow("cannot be updated safely")

        expect(providerFetch).toHaveBeenCalledTimes(3)
        expect(onAdded).not.toHaveBeenCalled()
        expect(onRemoved).not.toHaveBeenCalled()
    })

    test("applies overlapping replacements in order so the later write keeps both tracks", async () => {
        const membership: string[] = []
        let writes = 0
        let releaseFirstWrite: () => void = () => undefined
        const firstWrite = new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
        })
        let markFirstWriteStarted: () => void = () => undefined
        const firstWriteStarted = new Promise<void>((resolve) => {
            markFirstWriteStarted = resolve
        })
        providerFetch.mockImplementation(async (_account: ProviderAccountDocument, _url: string, init?: RequestInit) => {
            if (init?.method === "PUT") {
                writes += 1
                const body = JSON.parse(String(init.body)) as {playlist: {tracks: {urn: string}[]}}
                if (writes === 1) {
                    markFirstWriteStarted()
                    await firstWrite
                }
                membership.splice(0, membership.length, ...body.playlist.tracks.map((track) => track.urn))
                return {urn: playlistId}
            }
            return {collection: membership.map((urn) => ({urn, title: urn}))}
        })

        const first = soundcloudAdapter.addTracks(account, playlistId, ["soundcloud:tracks:12"])
        await firstWriteStarted
        const second = soundcloudAdapter.addTracks(account, playlistId, ["soundcloud:tracks:13"])
        releaseFirstWrite()
        await Promise.all([first, second])

        expect(membership).toEqual(["soundcloud:tracks:12", "soundcloud:tracks:13"])
    })

    test("removes a queued track after an earlier removal shifts its position", async () => {
        const membership = ["soundcloud:tracks:11", "soundcloud:tracks:12"]
        let writes = 0
        let releaseFirstWrite: () => void = () => undefined
        const firstWrite = new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
        })
        let markFirstWriteStarted: () => void = () => undefined
        const firstWriteStarted = new Promise<void>((resolve) => {
            markFirstWriteStarted = resolve
        })
        providerFetch.mockImplementation(async (_account: ProviderAccountDocument, _url: string, init?: RequestInit) => {
            if (init?.method === "PUT") {
                writes += 1
                const body = JSON.parse(String(init.body)) as {playlist: {tracks: {urn: string}[]}}
                if (writes === 1) {
                    markFirstWriteStarted()
                    await firstWrite
                }
                membership.splice(0, membership.length, ...body.playlist.tracks.map((track) => track.urn))
                return {urn: playlistId}
            }
            return {collection: membership.map((urn) => ({urn, title: urn}))}
        })

        const onFirstRemoved = mock(async () => undefined)
        const onSecondRemoved = mock(async () => undefined)
        const first = soundcloudAdapter.removePlaylistItems(account, playlistId, ["soundcloud:tracks:11:0"], onFirstRemoved)
        await firstWriteStarted
        const second = soundcloudAdapter.removePlaylistItems(account, playlistId, ["soundcloud:tracks:12:1"], onSecondRemoved)
        releaseFirstWrite()
        await Promise.all([first, second])

        expect(membership).toEqual([])
        expect(onFirstRemoved).toHaveBeenCalledWith(["soundcloud:tracks:11:0"])
        expect(onSecondRemoved).toHaveBeenCalledWith(["soundcloud:tracks:12:1"])
    })

    test("loads durations only for SoundCloud track URNs", async () => {
        await expect(soundcloudAdapter.getTrackDurations(account, ["1234", "dQw4w9WgXcQ"])).resolves.toEqual(new Map())
        expect(providerFetch).not.toHaveBeenCalled()

        providerFetch.mockResolvedValueOnce({
            collection: [{urn: "soundcloud:tracks:11", duration: 180000}]
        })

        const durations = await soundcloudAdapter.getTrackDurations(account, ["soundcloud:tracks:11"])

        expect(providerFetch).toHaveBeenCalledWith(account, "https://api.soundcloud.com/tracks?urns=soundcloud%3Atracks%3A11&linked_partitioning=true&limit=1", {headers: accept})
        expect(durations.get("soundcloud:tracks:11")).toBe(180000)
    })
})
