// List the authenticated user's connected provider accounts.
import {providers, type ProviderAccountDocument} from "~~/shared/types/domain"
import {collections} from "../data/collections"
import {requireUser} from "../domain/auth/session"
import {getProviderAdapter} from "../domain/providers"
import {ensureFreshAccessTokens} from "../domain/providers/token"
import {isProviderEnabled} from "../utils/provider-availability"
import logger from "../utils/logger"

// Resolve a playlist count without letting one provider failure hide the other accounts.
async function resolvePlaylistCount(account: ProviderAccountDocument): Promise<number | undefined> {
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

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const db = await collections()
    const accounts = await db.providerAccounts.find({userId: user._id!}).toArray()
    await ensureFreshAccessTokens(accounts)
    accounts.sort((left, right) => providers.indexOf(left.provider) - providers.indexOf(right.provider))
    const includePlaylistCount = getQuery(event).includePlaylistCount === "true"
    return {
        accounts: await Promise.all(
            accounts.map(async (account) => ({
                id: account._id?.toHexString(),
                provider: account.provider,
                displayName: account.displayName,
                email: account.email,
                playlistCount: includePlaylistCount ? await resolvePlaylistCount(account) : undefined,
                connectedAt: account.connectedAt,
                tokenExpiresAt: account.tokenExpiresAt
            }))
        )
    }
})
