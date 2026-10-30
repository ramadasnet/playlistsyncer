import {describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {Provider, ProviderAccountDocument} from "../shared/types/domain"
import type {ProviderAdapter, ProviderPlaylist} from "../server/domain/providers/types"
import * as providers from "../server/domain/providers"
import * as availability from "../server/utils/provider-availability"
import {serializeConnectedAccounts} from "../server/domain/accounts"
import logger from "../server/utils/logger"

const connectedAt = new Date("2026-09-20T00:00:00.000Z")
const tokenExpiresAt = new Date("2026-09-20T01:00:00.000Z")

function account(provider: Provider, id: string): ProviderAccountDocument {
    return {
        _id: new ObjectId(id),
        userId: new ObjectId("68c2c0a0c0a0c0a0c0a0c0a1"),
        provider,
        externalAccountId: `${provider}-user`,
        email: `${provider}@playlistsyncer.test`,
        emailVerified: true,
        displayName: `${provider} user`,
        accessToken: {version: 1, iv: "iv", ciphertext: "cipher"},
        scopes: [],
        connectedAt,
        updatedAt: connectedAt,
        tokenExpiresAt
    }
}

function adapter(listPlaylists: (account: ProviderAccountDocument) => Promise<ProviderPlaylist[]>): ProviderAdapter {
    return {
        provider: "spotify",
        listPlaylists,
        getPlaylistItems: async () => [],
        searchTrack: async () => null,
        searchTrackCandidates: async () => [],
        getTrackDurations: async () => new Map(),
        createPlaylist: async () => ({id: "playlist-id", name: "Created", itemCount: 0}),
        deletePlaylist: async () => undefined,
        addTracks: async () => undefined,
        removePlaylistItems: async () => undefined
    }
}

describe("connected account playlist counts", () => {
    test("keeps a successful account when another provider count fails", async () => {
        const spotify = account("spotify", "68c2c0a0c0a0c0a0c0a0c0a2")
        const tidal = account("tidal", "68c2c0a0c0a0c0a0c0a0c0a3")
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined)
        const enabled = spyOn(availability, "isProviderEnabled").mockReturnValue(true)
        const adapters = spyOn(providers, "getAccountAdapter").mockImplementation(({provider}) =>
            adapter(async (connected) => {
                if (connected.provider === "spotify") {
                    throw new Error("Spotify playlist count failed")
                }
                expect(provider).toBe(connected.provider)
                return [{id: "favorites", name: "Favorites", itemCount: 4}]
            })
        )

        try {
            const accounts = await serializeConnectedAccounts([spotify, tidal], true)

            expect(accounts).toEqual([
                {
                    id: spotify._id?.toHexString(),
                    provider: "spotify",
                    displayName: "spotify user",
                    email: "spotify@playlistsyncer.test",
                    playlistCount: undefined,
                    connectedAt,
                    tokenExpiresAt
                },
                {
                    id: tidal._id?.toHexString(),
                    provider: "tidal",
                    displayName: "tidal user",
                    email: "tidal@playlistsyncer.test",
                    playlistCount: 1,
                    connectedAt,
                    tokenExpiresAt
                }
            ])
            expect(warn).toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            enabled.mockRestore()
            adapters.mockRestore()
        }
    })
})
