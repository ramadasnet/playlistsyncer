// Replace the public PRO price with the Creem product price after startup.
import {loadCreemProPrice} from "../domain/billing/pro-price"
import {getServerConfig} from "../utils/config"

// Copy a successfully loaded Creem price into each request. The shared runtime config is frozen, and each request clones the env fallback.
export default defineNitroPlugin(async (nitroApp) => {
    const config = getServerConfig()
    const proPrice = await loadCreemProPrice(Boolean(config.creemApiKey), config.creemProProductId)
    if (!proPrice) {
        return
    }
    nitroApp.hooks.hook("request", (event) => {
        useRuntimeConfig(event).public.proPrice = proPrice
    })
})
