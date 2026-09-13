// Inject the resolved public trial cutoff into each Nitro request.
import {resolvePublicTrialCutoff} from "../../shared/trial"

// Keep runtime configuration aligned with environment and baked-in values.
export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook("request", (event) => {
        const config = useRuntimeConfig(event)
        config.public.proSubscriptionRequiredAt = resolvePublicTrialCutoff(process.env, String(config.public.proSubscriptionRequiredAt || ""))
    })
})
