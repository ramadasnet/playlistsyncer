// Keep the public SAFE_MODE flag aligned with server configuration.

import {getServerConfig} from "../utils/config"

// Copy the process-wide write-blocking flag into each request's public runtime config.
export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook("request", (event) => {
        const config = useRuntimeConfig(event)
        config.public.safeMode = getServerConfig().safeMode
    })
})
