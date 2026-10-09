// List the authenticated user's connected provider accounts.
import {providers} from "~~/shared/types/domain"
import {collections} from "../data/collections"
import {serializeConnectedAccounts} from "../domain/accounts"
import {requireUser} from "../domain/auth/session"
import {ensureFreshAccessTokens} from "../domain/providers/token"
import {enforceProviderRequestLimit} from "../utils/user-rate-limit"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const includePlaylistCount = getQuery(event).includePlaylistCount === "true"
    // Playlist counts list every playlist of each account, so only that variant counts against the limit.
    if (includePlaylistCount) {
        enforceProviderRequestLimit(event, user._id!)
    }
    const db = await collections()
    const accounts = await db.providerAccounts.find({userId: user._id!}).toArray()
    await ensureFreshAccessTokens(accounts)
    accounts.sort((left, right) => providers.indexOf(left.provider) - providers.indexOf(right.provider))
    return {
        accounts: await serializeConnectedAccounts(accounts, includePlaylistCount)
    }
})
