// Serialize connected provider accounts without letting one playlist-count failure hide the rest.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {getProviderAdapter} from "./providers"
import {isProviderEnabled} from "../utils/provider-availability"
import logger from "../utils/logger"

// Resolve a playlist count without letting one provider failure hide the other accounts.
export async function playlistCountForAccount(account: ProviderAccountDocument): Promise<number | undefined> {
    if (!isProviderEnabled(account.provider)) {
        return 0
    }
    try {
        return (await getProviderAdapter(account.provider).listPlaylists(account)).length
    } catch (error) {
        logger.warn("Accounts.playlistCount", account.provider, `Provider account ${account.externalAccountId}`, error)
        return undefined
    }
}

export async function serializeConnectedAccounts(accounts: ProviderAccountDocument[], includePlaylistCount: boolean) {
    return Promise.all(
        accounts.map(async (account) => ({
            id: account._id?.toHexString(),
            provider: account.provider,
            displayName: account.displayName,
            email: account.email,
            playlistCount: includePlaylistCount ? await playlistCountForAccount(account) : undefined,
            connectedAt: account.connectedAt,
            tokenExpiresAt: account.tokenExpiresAt
        }))
    )
}
