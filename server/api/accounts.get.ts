// List the authenticated user's connected provider accounts.
import {providers} from "~~/shared/types/domain"
import {collections} from "../data/collections"
import {serializeConnectedAccounts} from "../domain/accounts"
import {requireUser} from "../domain/auth/session"
import {ensureFreshAccessTokens} from "../domain/providers/token"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const db = await collections()
    const accounts = await db.providerAccounts.find({userId: user._id!}).toArray()
    await ensureFreshAccessTokens(accounts)
    accounts.sort((left, right) => providers.indexOf(left.provider) - providers.indexOf(right.provider))
    return {
        accounts: await serializeConnectedAccounts(accounts, getQuery(event).includePlaylistCount === "true")
    }
})
