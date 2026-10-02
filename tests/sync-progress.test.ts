import {describe, expect, test} from "bun:test"
import {formatSyncProgressMessage} from "../shared/sync-progress"

describe("sync progress messages", () => {
    test("describes full-account playlist progress", () => {
        expect(formatSyncProgressMessage("account", {playlistsTotal: 9, playlistsCompleted: 5})).toBe("5 out of 9 playlists synced...")
        expect(formatSyncProgressMessage("account", {playlistsTotal: 3, playlistsCompleted: 0})).toBe("0 out of 3 playlists synced...")
    })

    test("describes single-playlist track progress", () => {
        expect(formatSyncProgressMessage("playlist", {tracksTotal: 13})).toBe("Syncing 13 tracks...")
    })

    test("falls back while totals are still unknown", () => {
        expect(formatSyncProgressMessage("account", {})).toBe("Syncing...")
        expect(formatSyncProgressMessage("playlist")).toBe("Syncing...")
    })
})
