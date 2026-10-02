import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {mergeManualAliases, overlayPlaylistMappings, playlistMappingWriteFilter} from "../server/domain/sync/playlist-mappings"
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
            {sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-renamed", name: "Focus renamed", manualAliases: [alias("saved")]},
            {sourcePlaylistId: "yt-new", destinationPlaylistId: "sp-new", name: "Created"}
        ])
    })

    test("lets a requested alias replace the stored song and keeps a different saved alias", () => {
        const stored = [{sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("saved"), alias("song", "stored")]}]
        const desired = [{sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("song", "requested")]}]

        expect(overlayPlaylistMappings(stored, desired, {replaceAliases: true})).toEqual([{sourcePlaylistId: "yt-a", destinationPlaylistId: "sp-a", name: "Focus", manualAliases: [alias("saved"), alias("song", "requested")]}])
    })

    test("prefers the later alias when both copies name the same song", () => {
        expect(mergeManualAliases([alias("song", "earlier")], [alias("song", "later")])).toEqual([alias("song", "later")])
    })

    test("keeps every mapping write conditional on the version that was read", () => {
        const taskId = new ObjectId("68c2c0a0c0a0c0a0c0a0c0a0")
        const updatedAt = new Date("2026-10-01T12:00:00.000Z")
        const now = new Date("2026-10-01T12:05:00.000Z")

        expect(playlistMappingWriteFilter(taskId, updatedAt, false, now)).toEqual({_id: taskId, updatedAt})
        expect(playlistMappingWriteFilter(taskId, undefined, true, now)).toEqual({
            _id: taskId,
            updatedAt: {$exists: false},
            $or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lte: now}}]
        })
    })
})
