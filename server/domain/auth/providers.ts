// Describe OAuth endpoints and profile mapping for each provider.
import type {Provider} from "~~/shared/types/domain"
import {getServerConfig, requireConfig, type ServerConfig} from "../../utils/config"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"

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
async function fetchJson<T>(url: string, accessToken: string, extraHeaders?: HeadersInit): Promise<T> {
    const headers = new Headers(extraHeaders)
    headers.set("Authorization", `Bearer ${accessToken}`)
    const response = await fetchWithRetry(url, {headers}, {label: "OAuth.fetchProfile"})
    if (!response.ok) {
        const requestUrl = new URL(url)
        logger.error("OAuth.fetchProfile", requestUrl.hostname, requestUrl.pathname, `Status ${response.status}`)
        throw createError({statusCode: 502, statusMessage: `Provider profile request failed (${response.status})`})
    }
    return response.json() as Promise<T>
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
            }>("https://api.spotify.com/v1/me", accessToken)
            return {
                id: profile.id,
                email: profile.email,
                emailVerified: Boolean(profile.email),
                displayName: profile.display_name || profile.email || "Spotify user",
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
            }>("https://openidconnect.googleapis.com/v1/userinfo", accessToken)
            return {
                id: profile.sub,
                email: profile.email,
                emailVerified: profile.email_verified === true,
                displayName: profile.name || profile.email || "Google user",
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
            const profile = await fetchJson<{user_id: string; email?: string; name?: string}>("https://api.amazon.com/user/profile", accessToken)
            return {
                id: profile.user_id,
                email: profile.email,
                emailVerified: Boolean(profile.email),
                displayName: profile.name || profile.email || "Amazon user"
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
            }>("https://openapi.tidal.com/v2/users/me", accessToken, {Accept: "application/vnd.api+json"})
            const attributes = document.data.attributes || {}
            const displayName = [attributes.firstName, attributes.lastName].filter(Boolean).join(" ") || attributes.username || attributes.email || "TIDAL user"
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
