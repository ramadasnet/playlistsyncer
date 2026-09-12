import {resolvePublicTrialCutoff} from "../../shared/trial"

export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook("request", (event) => {
        const config = useRuntimeConfig(event)
        config.public.proSubscriptionRequiredAt = resolvePublicTrialCutoff(
            process.env,
            String(config.public.proSubscriptionRequiredAt || "")
        )
    })
})
