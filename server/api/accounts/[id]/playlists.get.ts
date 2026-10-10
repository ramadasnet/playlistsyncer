// List playlists from a connected provider account owned by the user.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {getProviderAdapter} from "../../../domain/providers"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"
import {enforceProviderRequestLimit} from "../../../utils/user-rate-limit"

// Check ownership before making the external provider request.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
    const accountId = parseObjectId(getRouterParam(event, "id"), "account id")
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: accountId, userId: user._id!})
    if (!account) {
        throw createError({statusCode: 404, statusMessage: "Provider account not found"})
    }
    // Destination pickers ask for writable playlists. Source pickers keep followed playlists.
    const writableOnly = getQuery(event).writable === "1"
    const playlists = await getProviderAdapter(account.provider).listPlaylists(account, writableOnly ? {writableOnly: true} : undefined)
    logger.info("Accounts.listPlaylists", account.provider, `Provider account ${account.externalAccountId}`, `Playlists ${playlists.length}`)
    return {playlists}
})
