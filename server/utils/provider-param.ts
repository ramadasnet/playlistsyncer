import type {H3Event} from "h3"
import {providers, type Provider} from "~~/shared/types/domain"

export function getProviderParam(event: H3Event): Provider {
    const provider = getRouterParam(event, "provider")
    if (!providers.includes(provider as Provider)) {
        throw createError({statusCode: 404, statusMessage: "Unknown provider"})
    }
    return provider as Provider
}
