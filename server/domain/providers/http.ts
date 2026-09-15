// Perform authenticated requests against provider APIs and normalize failures.
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import logger from "../../utils/logger"
import {getAccessToken} from "./token"

async function authorizedFetch(account: ProviderAccountDocument, url: string, init: RequestInit, forceRefresh = false): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${await getAccessToken(account, {force: forceRefresh})}`)
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json")
    }
    return fetch(url, {...init, headers})
}

// Add the current provider token, parse successful responses, and map errors.
export async function providerFetch<T>(account: ProviderAccountDocument, url: string, init: RequestInit = {}): Promise<T> {
    let response = await authorizedFetch(account, url, init)
    if (response.status === 401) {
        response = await authorizedFetch(account, url, init, true)
    }
    if (!response.ok) {
        const requestUrl = new URL(url)
        const logParts = [account.provider, init.method || "GET", requestUrl.pathname, `Status ${response.status}`, `Provider account ${account.externalAccountId}`]
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
