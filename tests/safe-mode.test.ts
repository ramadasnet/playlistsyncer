import {describe, expect, spyOn, test} from "bun:test"
import type {ProviderAccountDocument} from "../shared/types/domain"
import {withoutProviderWrites} from "../server/domain/providers"
import logger from "../server/utils/logger"
import {formatSafeModeFinalPlaylist, formatSafeModeTrack, logSafeModeCreatePlaylist, logSafeModeDeletePlaylist, logSafeModePlaylistUpdate, playlistAfterChanges, safeModeWriteBlockedMessage} from "../server/domain/sync/safe-mode"
import type {ProviderAdapter} from "../server/domain/providers/types"

const account = {provider: "spotify"} as ProviderAccountDocument

function recordingAdapter(): ProviderAdapter & {writes: string[]} {
    const writes: string[] = []
    return {
        provider: "spotify",
        writes,
        listPlaylists: async () => [],
        getPlaylistItems: async () => [],
        searchTrack: async () => null,
        searchTrackCandidates: async () => [],
        getTrackDurations: async () => new Map(),
        createPlaylist: async () => {
            writes.push("createPlaylist")
            return {id: "playlist-id", name: "Created", itemCount: 0}
        },
        deletePlaylist: async () => {
            writes.push("deletePlaylist")
        },
        addTracks: async () => {
            writes.push("addTracks")
        },
        removePlaylistItems: async () => {
            writes.push("removePlaylistItems")
        }
    }
}

describe("safe mode playlist logging", () => {
    test("formats tracks and the resulting playlist for logs", () => {
        expect(formatSafeModeTrack({title: "Pulse", artists: ["Ada", "Bea"]})).toBe("Pulse — Ada, Bea")
        expect(formatSafeModeTrack({title: "Pulse", artists: []})).toBe("Pulse")
        expect(formatSafeModeTrack({})).toBe("Unknown track")
        expect(
            formatSafeModeFinalPlaylist([
                {title: "Pulse", artists: ["Ada"]},
                {title: "Glow", artists: ["Bea"]}
            ])
        ).toBe("Pulse — Ada | Glow — Bea")
        expect(formatSafeModeFinalPlaylist([])).toBe("(empty)")
    })

    test("builds the playlist that would exist after additions and removals", () => {
        const kept = {itemId: "keep", title: "Kept"}
        const removed = {itemId: "drop", title: "Removed"}
        const added = {itemId: "add", title: "Added"}

        expect(playlistAfterChanges([kept, removed], ["drop"], [added])).toEqual([kept, added])
    })

    test("logs every planned change and the final playlist", () => {
        const info = spyOn(logger, "info").mockImplementation(() => undefined)
        try {
            logSafeModePlaylistUpdate({
                provider: "spotify",
                playlistId: "playlist-id",
                playlistName: "Road trip",
                removals: [{title: "Old Song", artists: ["Bea"]}],
                additions: [{title: "New Song", artists: ["Ada"]}],
                unmatched: [{title: "Missing Song", artists: ["Cara"]}],
                finalTracks: [
                    {title: "Kept", artists: ["Ada"]},
                    {title: "New Song", artists: ["Ada"]}
                ]
            })

            const messages = info.mock.calls.map((args) => args.map(String).join(" "))
            expect(messages.some((message) => message.includes("Skipping playlist writes"))).toBe(true)
            expect(messages.some((message) => message.includes("Would remove") && message.includes("Old Song — Bea"))).toBe(true)
            expect(messages.some((message) => message.includes("Would add") && message.includes("New Song — Ada"))).toBe(true)
            expect(messages.some((message) => message.includes("Would skip unmatched") && message.includes("Missing Song — Cara"))).toBe(true)
            expect(messages.some((message) => message.includes("Final playlist (2 tracks)") && message.includes("Kept — Ada | New Song — Ada"))).toBe(true)
        } finally {
            info.mockRestore()
        }
    })

    test("logs playlist creation and deletion instead of writing", () => {
        const info = spyOn(logger, "info").mockImplementation(() => undefined)
        try {
            logSafeModeCreatePlaylist("tidal", "Favorites")
            logSafeModeDeletePlaylist("tidal", "playlist-id", "Favorites", [{title: "Old Song", artists: ["Bea"]}])

            const messages = info.mock.calls.map((args) => args.map(String).join(" "))
            expect(messages.some((message) => message.includes("Would create playlist Favorites"))).toBe(true)
            expect(messages.some((message) => message.includes("Would delete playlist Favorites"))).toBe(true)
            expect(messages.some((message) => message.includes("Would remove") && message.includes("Old Song — Bea"))).toBe(true)
            expect(messages.some((message) => message.includes("Final playlist (deleted)"))).toBe(true)
        } finally {
            info.mockRestore()
        }
    })

    test("blocks every music provider write through the adapter", async () => {
        const inner = recordingAdapter()
        const adapter = withoutProviderWrites(inner)
        const info = spyOn(logger, "info").mockImplementation(() => undefined)
        try {
            await expect(adapter.createPlaylist(account, "Favorites")).rejects.toThrow(safeModeWriteBlockedMessage)
            await adapter.addTracks(account, "playlist-id", ["track-1", "track-2"])
            await adapter.removePlaylistItems(account, "playlist-id", ["item-1"])
            await adapter.deletePlaylist(account, "playlist-id")
            await adapter.listPlaylists(account)
            await adapter.getPlaylistItems(account, "playlist-id")
            await adapter.searchTrack(account, {itemId: "item", trackId: "track", title: "Pulse", artists: ["Ada"]})

            expect(inner.writes).toEqual([])
            const messages = info.mock.calls.map((args) => args.map(String).join(" "))
            expect(messages.some((message) => message.includes("Would create playlist Favorites"))).toBe(true)
            expect(messages.some((message) => message.includes("Blocked addTracks (2)"))).toBe(true)
            expect(messages.some((message) => message.includes("Blocked removePlaylistItems (1)"))).toBe(true)
            expect(messages.some((message) => message.includes("Would delete playlist playlist-id"))).toBe(true)
        } finally {
            info.mockRestore()
        }
    })
})
