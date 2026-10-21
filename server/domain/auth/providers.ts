// Describe OAuth endpoints and profile mapping for each provider.
import type {Provider} from "~~/shared/types/domain"
import {getServerConfig, requireConfig, type ServerConfig} from "../../utils/config"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {getProviderRateLimiter, maxQueueWaitMs} from "../providers/rate-limit"
import {appleClientSecret, readAppleIdToken} from "./apple"

interface OAuthProfile {
    id: string
    // Ids this provider account was stored under before, so the stored account is re-keyed on its next login.
    previousIds?: string[]
    email?: string
    emailVerified: boolean
    displayName: string
    avatarUrl?: string
}

interface OAuthProfileContext {
    idToken?: string
    // Nonce sent with the authorization request, which the ID token must repeat.
    nonce?: string
    displayNameHint?: string
}

interface OAuthProvider {
    authorizeUrl: string
    tokenUrl: string
    scopes: string[]
    clientIdKey: keyof ServerConfig
    clientSecretKey: keyof ServerConfig
    // Other settings the provider needs before it can be offered.
    extraConfigKeys?: (keyof ServerConfig)[]
    // Signs a client secret per request when the provider does not issue a static one.
    createClientSecret?: () => string
    tokenAuth: "basic" | "body"
    // Bind the ID token with an OpenID nonce instead of PKCE, which the provider does not document.
    idTokenNonce?: boolean
    responseMode?: "form_post"
    fetchProfile(accessToken: string, context?: OAuthProfileContext): Promise<OAuthProfile>
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
                account_id?: string
                email?: string
                display_name?: string
                images?: {url: string}[]
            }>("spotify", "https://api.spotify.com/v1/me", accessToken)
            // Spotify's user id can change, while account_id is immutable. Accounts linked before used the user id.
            const accountId = profile.account_id || profile.id
            return {
                id: accountId,
                ...(accountId !== profile.id ? {previousIds: [profile.id]} : {}),
                email: profile.email,
                // Spotify does not verify the email address, so it must never match or claim a local user.
                emailVerified: false,
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
                // Login with Amazon does not report whether the email is verified.
                emailVerified: false,
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
    },
    apple: {
        authorizeUrl: "https://appleid.apple.com/auth/authorize",
        tokenUrl: "https://appleid.apple.com/auth/token",
        scopes: ["name", "email"],
        clientIdKey: "appleClientId",
        clientSecretKey: "appleSigninPrivateKey",
        // Sign in with Apple identifies the user. Playlist access needs the MusicKit key too.
        extraConfigKeys: ["appleTeamId", "appleSigninKeyId", "appleMusicKeyId", "appleMusicPrivateKey"],
        createClientSecret: () => appleClientSecret(),
        tokenAuth: "body",
        idTokenNonce: true,
        // Apple requires form_post whenever the name or email scope is requested.
        responseMode: "form_post",
        async fetchProfile(_accessToken, context) {
            if (!context?.idToken) {
                throw createError({statusCode: 502, statusMessage: "Apple did not return an ID token"})
            }
            const claims = readAppleIdToken(context.idToken, {clientId: requireConfig("appleClientId"), nonce: context.nonce})
            return {
                id: claims.sub,
                email: claims.email,
                emailVerified: claims.emailVerified,
                // A private relay address is no display name, so only the name Apple posted on the first login is used.
                displayName: profileDisplayName("Apple Music user", context.displayNameHint)
            }
        }
    }
}

// Resolve an OAuth definition with its configured client credentials.
export function getOAuthProvider(provider: Provider): OAuthProvider & {clientId: string; clientSecret: string} {
    const definition = oauthProviders[provider]
    return {
        ...definition,
        clientId: requireConfig(definition.clientIdKey) as string,
        clientSecret: definition.createClientSecret ? definition.createClientSecret() : (requireConfig(definition.clientSecretKey) as string)
    }
}

// Check whether every credential a provider needs exists.
export function hasOAuthCredentials(provider: Provider, config: ServerConfig = getServerConfig()): boolean {
    const definition = oauthProviders[provider]
    return [definition.clientIdKey, definition.clientSecretKey, ...(definition.extraConfigKeys || [])].every((key) => Boolean(config[key]))
}

export type {OAuthProfile, OAuthProfileContext, OAuthProvider}
