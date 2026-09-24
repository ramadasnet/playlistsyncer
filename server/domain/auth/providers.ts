// Describe OAuth endpoints and profile mapping for each provider.
import type {Provider} from "~~/shared/types/domain"
import {getServerConfig, requireConfig, type ServerConfig} from "../../utils/config"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {getProviderRateLimiter, maxQueueWaitMs} from "../providers/rate-limit"

interface OAuthProfile {
    id: string
    email?: string
    emailVerified: boolean
    displayName: string
    avatarUrl?: string
}

interface OAuthProvider {
    authorizeUrl: string
    tokenUrl: string
    scopes: string[]
    clientIdKey: keyof ServerConfig
    clientSecretKey: keyof ServerConfig
    tokenAuth: "basic" | "body"
    fetchProfile(accessToken: string): Promise<OAuthProfile>
}

// Fetch a provider profile with a bearer token and normalized error handling.
async function fetchJson<T>(provider: Provider, url: string, accessToken: string, extraHeaders?: HeadersInit): Promise<T> {
    const headers = new Headers(extraHeaders)
    // A provider that does not use Bearer, such as SoundCloud, supplies its own Authorization header.
    if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${accessToken}`)
    }
    const limiter = getProviderRateLimiter(provider)
    const response = await fetchWithRetry(
        url,
        {headers},
        {
            label: "OAuth.fetchProfile",
            maxRetryAfterMs: maxQueueWaitMs,
            beforeAttempt: (signal) => limiter.acquire(signal),
            onRateLimited: (retryAfterMs) => limiter.onRateLimited(retryAfterMs)
        }
    )
    if (!response.ok) {
        const requestUrl = new URL(url)
        const rateLimited = response.status === 429
        const log = rateLimited ? logger.warn : logger.error
        log("OAuth.fetchProfile", requestUrl.hostname, requestUrl.pathname, `Status ${response.status}`)
        throw createError({statusCode: rateLimited ? 429 : 502, statusMessage: `Provider profile request failed (${response.status})`})
    }
    return response.json() as Promise<T>
}

// Use the first provider-supplied name that is not blank, so a whitespace-only name never becomes an empty display name.
function profileDisplayName(fallback: string, ...names: (string | undefined)[]): string {
    return names.map((name) => name?.trim()).find(Boolean) || fallback
}

const oauthProviders: Record<Provider, OAuthProvider> = {
    spotify: {
        authorizeUrl: "https://accounts.spotify.com/authorize",
        tokenUrl: "https://accounts.spotify.com/api/token",
        scopes: ["user-read-email", "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public"],
        clientIdKey: "spotifyClientId",
        clientSecretKey: "spotifyClientSecret",
        tokenAuth: "basic",
        async fetchProfile(accessToken) {
            const profile = await fetchJson<{
                id: string
                email?: string
                display_name?: string
                images?: {url: string}[]
            }>("spotify", "https://api.spotify.com/v1/me", accessToken)
            return {
                id: profile.id,
                email: profile.email,
                emailVerified: Boolean(profile.email),
                displayName: profileDisplayName("Spotify user", profile.display_name, profile.email),
                avatarUrl: profile.images?.[0]?.url
            }
        }
    },
    youtube: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/youtube"],
        clientIdKey: "googleClientId",
        clientSecretKey: "googleClientSecret",
        tokenAuth: "body",
        async fetchProfile(accessToken) {
            const profile = await fetchJson<{
                sub: string
                email?: string
                email_verified?: boolean
                name?: string
                picture?: string
            }>("youtube", "https://openidconnect.googleapis.com/v1/userinfo", accessToken)
            return {
                id: profile.sub,
                email: profile.email,
                emailVerified: profile.email_verified === true,
                displayName: profileDisplayName("Google user", profile.name, profile.email),
                avatarUrl: profile.picture
            }
        }
    },
    amazon: {
        authorizeUrl: "https://www.amazon.com/ap/oa",
        tokenUrl: "https://api.amazon.com/auth/o2/token",
        scopes: ["profile"],
        clientIdKey: "amazonClientId",
        clientSecretKey: "amazonClientSecret",
        tokenAuth: "body",
        async fetchProfile(accessToken) {
            const profile = await fetchJson<{user_id: string; email?: string; name?: string}>("amazon", "https://api.amazon.com/user/profile", accessToken)
            return {
                id: profile.user_id,
                email: profile.email,
                emailVerified: Boolean(profile.email),
                displayName: profileDisplayName("Amazon user", profile.name, profile.email)
            }
        }
    },
    soundcloud: {
        authorizeUrl: "https://secure.soundcloud.com/authorize",
        tokenUrl: "https://secure.soundcloud.com/oauth/token",
        // SoundCloud's authorization-code guide does not request a scope.
        scopes: [],
        clientIdKey: "soundcloudClientId",
        clientSecretKey: "soundcloudClientSecret",
        tokenAuth: "body",
        async fetchProfile(accessToken) {
            const profile = await fetchJson<{
                urn?: string
                username?: string
                full_name?: string
                avatar_url?: string
            }>("soundcloud", "https://api.soundcloud.com/me", accessToken, {
                Accept: "application/json; charset=utf-8",
                Authorization: `OAuth ${accessToken}`
            })
            if (!profile.urn) {
                throw createError({statusCode: 502, statusMessage: "SoundCloud profile did not include an account id"})
            }
            return {
                id: profile.urn,
                emailVerified: false,
                displayName: profileDisplayName("SoundCloud user", profile.full_name, profile.username),
                avatarUrl: profile.avatar_url?.trim() || undefined
            }
        }
    },
    tidal: {
        authorizeUrl: "https://login.tidal.com/authorize",
        tokenUrl: "https://auth.tidal.com/v1/oauth2/token",
        scopes: ["user.read", "playlists.read", "playlists.write", "search.read"],
        clientIdKey: "tidalClientId",
        clientSecretKey: "tidalClientSecret",
        tokenAuth: "body",
        async fetchProfile(accessToken) {
            const document = await fetchJson<{
                data: {
                    id: string
                    attributes?: {
                        email?: string
                        emailVerified?: boolean
                        firstName?: string
                        lastName?: string
                        username?: string
                    }
                }
            }>("tidal", "https://openapi.tidal.com/v2/users/me", accessToken, {Accept: "application/vnd.api+json"})
            const attributes = document.data.attributes || {}
            const displayName = profileDisplayName("TIDAL user", [attributes.firstName, attributes.lastName].filter(Boolean).join(" "), attributes.username, attributes.email)
            return {
                id: document.data.id,
                email: attributes.email,
                emailVerified: attributes.emailVerified === true,
                displayName
            }
        }
    }
}

// Resolve an OAuth definition with its configured client credentials.
export function getOAuthProvider(provider: Provider): OAuthProvider & {clientId: string; clientSecret: string} {
    const definition = oauthProviders[provider]
    const config = getServerConfig()
    return {
        ...definition,
        clientId: requireConfig(definition.clientIdKey) as string,
        clientSecret: requireConfig(definition.clientSecretKey) as string
    }
}

// Check whether both OAuth credentials exist for a provider.
export function hasOAuthCredentials(provider: Provider, config: ServerConfig = getServerConfig()): boolean {
    const definition = oauthProviders[provider]
    return Boolean(config[definition.clientIdKey] && config[definition.clientSecretKey])
}

export type {OAuthProfile, OAuthProvider}
