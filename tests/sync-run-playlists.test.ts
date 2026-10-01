import {describe, expect, test} from "bun:test"
import {formatRunPlaylistLabel, groupRunPlaylists} from "../shared/sync-run-playlists"

describe("matched playlist groups", () => {
    test("merges both providers of a playlist pair into one option", () => {
        const groups = groupRunPlaylists({
            mode: "playlist",
            source: {playlistId: "src-1", name: "Road Trip"},
            destination: {playlistId: "dst-1", name: "Road Trip"},
            addedTracks: [
                {playlistId: "dst-1", playlistName: "Road Trip"},
                {playlistId: "src-1", playlistName: "Road Trip"}
            ],
            removedTracks: [{playlistId: "dst-1", playlistName: "Road Trip"}],
            unmatchedTracks: [{playlistId: "src-1", playlistName: "Road Trip"}]
        })

        expect(groups).toEqual([{key: "src-1", name: "Road Trip", ids: ["src-1", "dst-1"], added: 2, removed: 1, unmatched: 1, unavailable: 0}])
        expect(formatRunPlaylistLabel(groups[0]!)).toBe("Road Trip 2+ 1- 1?")
    })

    test("uses the account mapping so each matched playlist appears once", () => {
        const groups = groupRunPlaylists({
            mode: "account",
            source: {playlistId: "all", name: "All playlists"},
            destination: {playlistId: "all", name: "All playlists"},
            playlistMappings: [
                {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus"},
                {sourcePlaylistId: "yt-b", destinationPlaylistId: "sp-b", name: "Sleep"}
            ],
            addedTracks: [
                {playlistId: "sp-a", playlistName: "Focus"},
                {playlistId: "sp-b", playlistName: "Sleep"}
            ],
            removedTracks: [{playlistId: "yt-a", playlistName: "Focus"}],
            unmatchedTracks: [
                {playlistId: "yt-b", playlistName: "Sleep"},
                {playlistId: "yt-b", playlistName: "Sleep"}
            ]
        })

        expect(groups.map((group) => formatRunPlaylistLabel(group))).toEqual(["Focus 1+ 1- 0?", "Sleep 1+ 0- 2?"])
    })

    test("collapses same-named provider copies when a mapping is missing", () => {
        const groups = groupRunPlaylists({
            mode: "account",
            source: {playlistId: "all", name: "All playlists"},
            destination: {playlistId: "all", name: "All playlists"},
            addedTracks: [{playlistId: "sp-a", playlistName: "Focus"}],
            removedTracks: [{playlistId: "yt-a", playlistName: "Focus"}],
            unmatchedTracks: []
        })

        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({name: "Focus", added: 1, removed: 1, unmatched: 0, unavailable: 0})
        expect(groups[0]!.ids.sort()).toEqual(["sp-a", "yt-a"])
    })

    test("counts deleted and private videos separately from unmatched tracks", () => {
        const groups = groupRunPlaylists({
            mode: "playlist",
            source: {playlistId: "yt-1", name: "Road Trip"},
            destination: {playlistId: "sp-1", name: "Road Trip"},
            addedTracks: [],
            removedTracks: [],
            unmatchedTracks: [
                {playlistId: "yt-1", playlistName: "Road Trip", title: "Midnight Radio"},
                {playlistId: "yt-1", playlistName: "Road Trip", title: "Deleted video"},
                {playlistId: "yt-1", playlistName: "Road Trip", title: "Private video"},
                {playlistId: "yt-1", playlistName: "Road Trip", title: "[Private video]"}
            ]
        })

        expect(groups).toEqual([{key: "yt-1", name: "Road Trip", ids: ["yt-1", "sp-1"], added: 0, removed: 0, unmatched: 1, unavailable: 3}])
        expect(formatRunPlaylistLabel(groups[0]!)).toBe("Road Trip 0+ 0- 1?")
    })
})
