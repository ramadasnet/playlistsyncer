// Keep public runtime config aligned with the server environment on every request.

import {resolvePublicTrialCutoff} from "../../shared/trial"
import {getServerConfig} from "../utils/config"

// Public settings otherwise retain their build-time values when the app is deployed with PLS_ variables.
export default defineNitroPlugin((nitroApp) => {
    const serverConfig = getServerConfig()
    nitroApp.hooks.hook("request", (event) => {
        const config = useRuntimeConfig(event)
        config.public.appName = process.env.PLS_APP_NAME || config.public.appName
        config.public.supportEmail = process.env.PLS_SUPPORT_EMAIL || config.public.supportEmail
        config.public.chatlabHelpUrl = process.env.PLS_CHATLAB_HELP_URL || config.public.chatlabHelpUrl
        config.public.siteUrl = serverConfig.appUrl
        config.public.proSubscriptionRequiredAt = resolvePublicTrialCutoff(process.env, serverConfig.proSubscriptionRequiredAt?.toISOString())
        config.public.proSyncIntervalMinutes = serverConfig.proSyncIntervalMinutes
        config.public.safeMode = serverConfig.safeMode
    })
})
