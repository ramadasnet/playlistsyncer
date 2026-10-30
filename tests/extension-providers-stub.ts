// Stub provider connectors bundled into the background script by the scheduler tests. They report one fixed Spotify account
// and run commands through the real tab helpers, so the tests exercise tabs.ts without touching provider internals.
import type {ExtensionProviderAccount} from "../shared/types/extension"
import type {ProviderConnector} from "../extension/src/providers/types"
import {openProviderTab, runInTab} from "../extension/src/tabs"

const account: ExtensionProviderAccount = {provider: "spotify", accountId: "acc-1", displayName: "Listener"}
const url = "https://open.spotify.com/"

async function inTab<R>(fn: () => R): Promise<R> {
    const tabId = await openProviderTab(url, [`${url}*`])
    return runInTab(tabId, fn, [])
}

const stub: ProviderConnector = {
    provider: "spotify",
    name: "Spotify",
    loginUrl: url,
    tabPatterns: [`${url}*`],
    detectAccount: () => inTab(() => account),
    listPlaylists: () => inTab(() => [{id: "p1", name: "Mix"}]),
    createPlaylist: () => inTab(() => ({id: "p2", name: "New"})),
    deletePlaylist: () => inTab(() => null),
    getPlaylistItems: () => inTab(() => []),
    searchTrackCandidates: () => inTab(() => []),
    getTrackDurations: () => inTab(() => ({})),
    addTracks: () => inTab(() => []),
    removePlaylistItems: () => inTab(() => null)
}

export const connectors: ProviderConnector[] = [stub]

export function getConnector(provider: string): ProviderConnector | undefined {
    return connectors.find((c) => c.provider === provider)
}
