import {createError, defineEventHandler} from "h3"
import {runtimeSettingsReady} from "../utils/runtime-settings"

export default defineEventHandler(async () => {
    await runtimeSettingsReady.catch(() => {
        throw createError({statusCode: 503, statusMessage: "Application settings unavailable"})
    })
})
