import type {ProviderAccountDocument} from "~~/shared/types/domain"
import logger from "../../utils/logger"
import {getAccessToken} from "./token"

export async function providerFetch<T>(
    account: ProviderAccountDocument,
    url: string,
    init: RequestInit = {}
): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${await getAccessToken(account)}`)
    if (init.body) {
        headers.set("Content-Type", "application/json")
    }
    const response = await fetch(url, {...init, headers})
    if (!response.ok) {
        const requestUrl = new URL(url)
        const logParts = [
            account.provider,
            init.method || "GET",
            requestUrl.pathname,
            `Status ${response.status}`,
            `Provider account ${account.externalAccountId}`
        ]
        if (response.status === 429) {
            logger.warn("Provider.request", ...logParts, "Rate limited")
        } else {
            logger.error("Provider.request", ...logParts)
        }
        throw createError({
            statusCode: response.status === 429 ? 429 : 502,
            statusMessage: `${account.provider} API request failed (${response.status})`
        })
    }
    if (response.status === 204) {
        return undefined as T
    }
    return response.json() as Promise<T>
}
