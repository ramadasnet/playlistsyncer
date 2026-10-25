// Sign the ES256 tokens required by Sign in with Apple and the Apple Music API, and read Apple ID tokens.
import {createPrivateKey, sign} from "node:crypto"
import type {ProviderAccountDocument} from "~~/shared/types/domain"
import {requireConfig} from "../../utils/config"
import {decryptSecret} from "../../utils/secrets"

export const appleIssuer = "https://appleid.apple.com"
export const appleMusicAuthorizationMessage = "Apple Music access is missing or has expired. Authorize Apple Music again on the Account page."
const clientSecretSeconds = 5 * 60
const developerTokenSeconds = 12 * 60 * 60
const developerTokenRenewMs = 60 * 60 * 1000

const developerTokens = new Map<string, {token: string; expiresAt: number}>()

function base64UrlJson(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url")
}

// ES256 JWTs carry the raw r||s signature, not the DER encoding Node produces by default.
export function signAppleJwt(keyId: string, privateKey: string, payload: Record<string, unknown>): string {
    const input = `${base64UrlJson({alg: "ES256", kid: keyId})}.${base64UrlJson(payload)}`
    const signature = sign("sha256", Buffer.from(input), {key: createPrivateKey(privateKey), dsaEncoding: "ieee-p1363"})
    return `${input}.${signature.toString("base64url")}`
}

// Sign in with Apple authenticates the token request with a short-lived JWT instead of a static client secret.
export function appleClientSecret(now = Date.now()): string {
    const issuedAt = Math.floor(now / 1000)
    return signAppleJwt(requireConfig("appleSigninKeyId"), requireConfig("appleSigninPrivateKey"), {
        iss: requireConfig("appleTeamId"),
        iat: issuedAt,
        exp: issuedAt + clientSecretSeconds,
        aud: appleIssuer,
        sub: requireConfig("appleClientId")
    })
}

// A token for the browser is limited to this site's origin. Server requests send no Origin, so their token has no origin claim.
export function appleMusicDeveloperToken(origin?: string, now = Date.now()): string {
    const cacheKey = origin || ""
    const cached = developerTokens.get(cacheKey)
    if (cached && cached.expiresAt - now > developerTokenRenewMs) {
        return cached.token
    }
    const issuedAt = Math.floor(now / 1000)
    const expiresAt = issuedAt + developerTokenSeconds
    const token = signAppleJwt(requireConfig("appleSigninKeyId"), requireConfig("appleSigninPrivateKey"), {
        iss: requireConfig("appleTeamId"),
        iat: issuedAt,
        exp: expiresAt,
        ...(origin ? {origin: [origin]} : {})
    })
    developerTokens.set(cacheKey, {token, expiresAt: expiresAt * 1000})
    return token
}

// Drop cached developer tokens so a test or key rotation signs new ones.
export function clearAppleMusicDeveloperTokens(): void {
    developerTokens.clear()
}

// Decrypt the MusicKit user token that authorizes Apple Music library requests.
export async function appleMusicUserToken(account: Pick<ProviderAccountDocument, "musicUserToken">): Promise<string> {
    if (!account.musicUserToken) {
        throw createError({statusCode: 409, statusMessage: appleMusicAuthorizationMessage})
    }
    return decryptSecret(account.musicUserToken)
}

export interface AppleIdTokenClaims {
    sub: string
    email?: string
    emailVerified: boolean
}

/**
 * Read the claims of an ID token received directly from Apple's token endpoint.
 * TLS already authenticates that response, so the signature is not checked (OpenID Connect Core 3.1.3.7).
 */
export function readAppleIdToken(idToken: string, expected: {clientId: string; nonce?: string}, now = Date.now()): AppleIdTokenClaims {
    let claims: Record<string, unknown> | undefined
    try {
        claims = JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8"))
    } catch {
        claims = undefined
    }
    const audience = claims?.aud
    const audienceMatches = Array.isArray(audience) ? audience.includes(expected.clientId) : audience === expected.clientId
    const valid = claims?.iss === appleIssuer && audienceMatches && typeof claims.sub === "string" && Boolean(claims.sub) && typeof claims.exp === "number" && claims.exp * 1000 > now && (!expected.nonce || claims.nonce === expected.nonce)
    if (!valid) {
        throw createError({statusCode: 502, statusMessage: "Apple returned an invalid ID token"})
    }
    const email = typeof claims!.email === "string" && claims!.email.trim() ? claims!.email.trim() : undefined
    return {
        sub: claims!.sub as string,
        email,
        // Apple sends booleans as strings in some ID tokens.
        emailVerified: Boolean(email) && (claims!.email_verified === true || claims!.email_verified === "true")
    }
}
