import {describe, expect, test} from "bun:test"
import {randomUUID} from "node:crypto"
import {isMissingPlaylistError} from "../server/domain/providers/http"
import {isExtensionOnline, registerExtensionPoll, sendExtensionCommand, submitExtensionResults, takeExtensionCommands, unregisterExtensionClient} from "../server/domain/extension/bridge"

const spotifyAccount = {provider: "spotify" as const, accountId: "listener", displayName: "Listener"}

// Each test uses its own user and client, because the bridge keeps state for the whole process.
function link() {
    const userId = randomUUID()
    const clientId = randomUUID()
    registerExtensionPoll(clientId, userId, [spotifyAccount])
    return {userId, clientId}
}

describe("extension bridge", () => {
    test("delivers a command to the polling client and resolves with its result", async () => {
        const {userId, clientId} = link()
        const pending = sendExtensionCommand(userId, "spotify", "listener", "listPlaylists", {})
        const [command] = await takeExtensionCommands(clientId)
        expect(command?.method).toBe("listPlaylists")
        expect(submitExtensionResults(clientId, [{id: command!.id, ok: true, result: [{id: "p1", name: "Mix"}]}])).toBe(1)
        expect(await pending).toEqual([{id: "p1", name: "Mix"}])
        unregisterExtensionClient(clientId)
    })

    test("wakes a waiting poll when a command arrives", async () => {
        const {userId, clientId} = link()
        const poll = takeExtensionCommands(clientId)
        const pending = sendExtensionCommand(userId, "spotify", "listener", "deletePlaylist", {playlistId: "p1"})
        const [command] = await poll
        submitExtensionResults(clientId, [{id: command!.id, ok: true, result: null}])
        expect(await pending).toBeNull()
        unregisterExtensionClient(clientId)
    })

    test("fails fast when no extension of the user is online for that account", async () => {
        const {userId, clientId} = link()
        expect(isExtensionOnline(userId, "amazon")).toBe(false)
        await expect(sendExtensionCommand(userId, "spotify", "someone-else", "listPlaylists", {})).rejects.toMatchObject({statusCode: 409})
        unregisterExtensionClient(clientId)
    })

    test("ignores results from a client that does not hold the command", async () => {
        const {userId, clientId} = link()
        const other = randomUUID()
        registerExtensionPoll(other, randomUUID(), [spotifyAccount])
        const pending = sendExtensionCommand(userId, "spotify", "listener", "listPlaylists", {})
        const [command] = await takeExtensionCommands(clientId)
        expect(await takeExtensionCommands(other, AbortSignal.abort())).toEqual([])
        expect(submitExtensionResults(other, [{id: command!.id, ok: true, result: []}])).toBe(0)
        submitExtensionResults(clientId, [{id: command!.id, ok: true, result: []}])
        expect(await pending).toEqual([])
        unregisterExtensionClient(clientId)
        unregisterExtensionClient(other)
    })

    test("maps a missing playlist to the error the sync engine treats as missing", async () => {
        const {userId, clientId} = link()
        const pending = sendExtensionCommand(userId, "spotify", "listener", "getPlaylistItems", {playlistId: "gone"})
        const [command] = await takeExtensionCommands(clientId)
        submitExtensionResults(clientId, [{id: command!.id, ok: false, error: {message: "Not found", code: "not_found"}}])
        const error = await pending.catch((caught: unknown) => caught)
        expect(isMissingPlaylistError(error)).toBe(true)
        unregisterExtensionClient(clientId)
    })

    test("maps a signed-out provider to a conflict that asks the user to sign in", async () => {
        const {userId, clientId} = link()
        const pending = sendExtensionCommand(userId, "spotify", "listener", "listPlaylists", {})
        const [command] = await takeExtensionCommands(clientId)
        submitExtensionResults(clientId, [{id: command!.id, ok: false, error: {message: "Signed out", code: "auth"}}])
        await expect(pending).rejects.toMatchObject({statusCode: 409, statusMessage: expect.stringContaining("Sign in to Spotify")})
        unregisterExtensionClient(clientId)
    })

    test("fails the commands of a client that is disconnected", async () => {
        const {userId, clientId} = link()
        const pending = sendExtensionCommand(userId, "spotify", "listener", "listPlaylists", {})
        await takeExtensionCommands(clientId)
        unregisterExtensionClient(clientId)
        await expect(pending).rejects.toMatchObject({statusCode: 502})
    })
})
