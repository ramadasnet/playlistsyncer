// Give the signed-in browser a MusicKit developer token, limited to this site's origin.
import {appleMusicDeveloperToken} from "../../domain/auth/apple"
import {requireUser} from "../../domain/auth/session"
import {getServerConfig} from "../../utils/config"
import {isProviderEnabled} from "../../utils/provider-availability"

export default defineEventHandler(async (event) => {
    await requireUser(event)
    if (!isProviderEnabled("apple")) {
        throw createError({statusCode: 404, statusMessage: "Apple Music is not available"})
    }
    return {developerToken: appleMusicDeveloperToken(getServerConfig().appUrl)}
})
