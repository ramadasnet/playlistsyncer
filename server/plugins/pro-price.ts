// Replace the public PRO price with the Creem product price after startup.
import {loadCreemProPrice, setResolvedProPrice} from "../domain/billing/pro-price"
import {getServerConfig} from "../utils/config"

// Copy a successfully loaded Creem price into each request's runtime config for server-rendered pages, and cache it for the /api/pro-price
// endpoint so client-side navigation (which never re-renders on the server) still observes the resolved price instead of the baked fallback.
export default defineNitroPlugin(async (nitroApp) => {
    const config = getServerConfig()
    const proPrice = await loadCreemProPrice(Boolean(config.creemApiKey), config.creemProProductId)
    if (!proPrice) {
        return
    }
    setResolvedProPrice(proPrice)
    nitroApp.hooks.hook("request", (event) => {
        useRuntimeConfig(event).public.proPrice = proPrice
    })
})
