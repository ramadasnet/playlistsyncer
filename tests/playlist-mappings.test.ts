import {describe, expect, test} from "bun:test"
import {mergeManualAliases, overlayPlaylistMappings} from "../server/domain/sync/playlist-mappings"
import type {ManualTrackAlias} from "../shared/types/domain"

function alias(sourceTrackId: string, canonicalKey = sourceTrackId): ManualTrackAlias {
    return {sourceTrackId, destinationTrackId: `dest-${sourceTrackId}`, canonicalKey}
}

describe("playlist mapping copies", () => {
    test("keeps a saved alias when an older mapping copy is written", () => {
        const stored = [{sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("saved")]}]
        const desired = [
            {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus"},
            {sourcePlaylistId: "yt-b", destinationPlaylistId: "sp-b", name: "Sleep"}
        ]

        expect(overlayPlaylistMappings(stored, desired)).toEqual([
            {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("saved")]},
            {sourcePlaylistId: "yt-b", destinationPlaylistId: "sp-b", name: "Sleep"}
        ])
    })

    test("keeps a mapping the older copy does not know about", () => {
        const stored = [
            {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("saved")]},
            {sourcePlaylistId: "yt-new", destinationPlaylistId: "sp-new", name: "Created"}
        ]
        const desired = [{sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-renamed", name: "Focus renamed", manualAliases: [alias("local")]}]

        expect(overlayPlaylistMappings(stored, desired)).toEqual([
            {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-renamed", name: "Focus renamed", manualAliases: [alias("local"), alias("saved")]},
            {sourcePlaylistId: "yt-new", destinationPlaylistId: "sp-new", name: "Created"}
        ])
    })

    test("prefers the stored alias when both copies name the same song", () => {
        expect(mergeManualAliases([alias("song", "old")], [alias("song", "new")])).toEqual([alias("song", "new")])
    })
})
