// Save the MusicKit user token the browser obtained for the user's Sign in with Apple account.
import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {readAppleStorefront} from "../../domain/providers/apple"
import logger from "../../utils/logger"
import {encryptSecret} from "../../utils/secrets"
import {enforceProviderRequestLimit} from "../../utils/user-rate-limit"

const schema = z.object({
    musicUserToken: z.string().trim().min(1).max(4096)
})

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
    const body = schema.parse(await readBody(event))
    const db = await collections()
    const account = await db.providerAccounts.findOne({userId: user._id!, provider: "apple"})
    if (!account) {
        throw createError({statusCode: 404, statusMessage: "Connect Apple Music before authorizing it"})
    }
    const musicUserToken = await encryptSecret(body.musicUserToken)
    // A token that cannot read the storefront would fail every sync, so it is checked before it is saved.
    const storefront = await readAppleStorefront({...account, musicUserToken})
    await db.providerAccounts.updateOne({_id: account._id, userId: user._id!}, {$set: {musicUserToken, storefront, updatedAt: new Date()}})
    logger.info("AppleMusic.authorize", `User ${user._id!.toHexString()}`, `Provider account ${account.externalAccountId}`, `Storefront ${storefront}`)
    return {ok: true}
})
