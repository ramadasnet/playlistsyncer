import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {getProviderAdapter} from "../../../domain/providers"
import logger from "../../../utils/logger"
import {parseObjectId} from "../../../utils/object-id"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const accountId = parseObjectId(getRouterParam(event, "id"), "account id")
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: accountId, userId: user._id!})
    if (!account) {
        throw createError({statusCode: 404, statusMessage: "Provider account not found"})
    }
    const playlists = await getProviderAdapter(account.provider).listPlaylists(account)
    logger.info(
        "Accounts.listPlaylists",
        account.provider,
        `Provider account ${account.externalAccountId}`,
        `Playlists ${playlists.length}`
    )
    return {playlists}
})
