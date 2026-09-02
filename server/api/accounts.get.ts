import {collections} from "../data/collections"
import {requireUser} from "../domain/auth/session"
import {getProviderAdapter} from "../domain/providers"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const db = await collections()
    const accounts = await db.providerAccounts.find({userId: user._id!}).sort({provider: 1}).toArray()
    const includePlaylistCount = getQuery(event).includePlaylistCount === "true"
    return {
        accounts: await Promise.all(
            accounts.map(async (account) => ({
                id: account._id?.toHexString(),
                provider: account.provider,
                displayName: account.displayName,
                email: account.email,
                playlistCount: includePlaylistCount
                    ? (await getProviderAdapter(account.provider).listPlaylists(account)).length
                    : undefined,
                connectedAt: account.connectedAt,
                tokenExpiresAt: account.tokenExpiresAt
            }))
        )
    }
})
