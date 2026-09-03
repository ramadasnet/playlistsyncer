import {createHash, randomBytes} from "node:crypto"
import type {H3Event} from "h3"
import {ObjectId} from "mongodb"
import type {Provider} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {encryptSecret} from "../../utils/secrets"
import {getOAuthProvider, type OAuthProfile} from "./providers"
import {isProviderEnabled} from "../../utils/provider-availability"
import {createSession, getCurrentUser, hashOpaqueToken} from "./session"

function callbackUrl(provider: Provider): string {
    return `${getServerConfig().appUrl}/api/auth/${provider}/callback`
}

function normalizeRedirect(value: unknown): string {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/sync"
}

export async function beginOAuth(event: H3Event, provider: Provider): Promise<string> {
    if (!isProviderEnabled(provider)) {
        throw createError({statusCode: 404, statusMessage: "Unknown provider"})
    }
    const definition = getOAuthProvider(provider)
    const state = randomBytes(32).toString("base64url")
    const codeVerifier = randomBytes(48).toString("base64url")
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const currentUser = await getCurrentUser(event)
    const db = await collections()
    const now = new Date()
    await db.oauthTransactions.insertOne({
        provider,
        stateHash: hashOpaqueToken(state),
        codeVerifier,
        linkingUserId: currentUser?._id,
        redirectAfter: normalizeRedirect(getQuery(event).redirect),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000)
    })
    logger.info(
        "OAuth.begin",
        provider,
        currentUser?._id ? `Linking user ${currentUser._id.toHexString()}` : "New login"
    )

    const url = new URL(definition.authorizeUrl)
    url.searchParams.set("client_id", definition.clientId)
    url.searchParams.set("redirect_uri", callbackUrl(provider))
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", definition.scopes.join(" "))
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge", challenge)
    url.searchParams.set("code_challenge_method", "S256")
    if (provider === "youtube") {
        url.searchParams.set("access_type", "offline")
        url.searchParams.set("prompt", "consent")
    }
    return url.toString()
}

async function exchangeCode(provider: Provider, code: string, codeVerifier: string) {
    const definition = getOAuthProvider(provider)
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(provider),
        code_verifier: codeVerifier
    })
    const headers = new Headers({"Content-Type": "application/x-www-form-urlencoded"})
    if (definition.tokenAuth === "basic") {
        headers.set(
            "Authorization",
            `Basic ${Buffer.from(`${definition.clientId}:${definition.clientSecret}`).toString("base64")}`
        )
    } else {
        body.set("client_id", definition.clientId)
        body.set("client_secret", definition.clientSecret)
    }
    const response = await fetch(definition.tokenUrl, {method: "POST", headers, body})
    if (!response.ok) {
        logger.error("OAuth.exchangeCode", provider, `Provider returned status ${response.status}`)
        throw createError({statusCode: 502, statusMessage: `OAuth token exchange failed (${response.status})`})
    }
    const token = (await response.json()) as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        scope?: string
    }
    return {token, definition}
}

async function findOrCreateUser(profile: OAuthProfile, linkingUserId?: ObjectId) {
    const db = await collections()
    if (linkingUserId) {
        const linkedUser = await db.users.findOne({_id: linkingUserId})
        if (!linkedUser) {
            logger.warn(
                "OAuth.findOrCreateUser",
                `Linking user ${linkingUserId.toHexString()}`,
                "User no longer exists"
            )
            throw createError({statusCode: 401, statusMessage: "Linking session is no longer valid"})
        }
        logger.info("OAuth.findOrCreateUser", `Linking existing user ${linkingUserId.toHexString()}`)
        return linkedUser
    }
    if (!profile.email || !profile.emailVerified) {
        logger.warn("OAuth.findOrCreateUser", `Provider account ${profile.id}`, "Verified email is unavailable")
        throw createError({statusCode: 400, statusMessage: "A verified provider email is required for registration"})
    }
    const email = profile.email.trim().toLowerCase()
    const existingUser = await db.users.findOne({email})
    if (existingUser) {
        logger.info("OAuth.findOrCreateUser", `Matched existing user ${existingUser._id!.toHexString()}`)
        return existingUser
    }
    const now = new Date()
    const result = await db.users.insertOne({
        email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        tier: "free",
        createdAt: now,
        updatedAt: now
    })
    logger.info("OAuth.findOrCreateUser", `Created user ${result.insertedId.toHexString()}`)
    return db.users.findOne({_id: result.insertedId}).then((user) => user!)
}

export async function finishOAuth(event: H3Event, provider: Provider, code: string, state: string): Promise<string> {
    const db = await collections()
    const transaction = await db.oauthTransactions.findOneAndDelete({
        provider,
        stateHash: hashOpaqueToken(state),
        expiresAt: {$gt: new Date()}
    })
    if (!transaction) {
        logger.warn("OAuth.finish", provider, "OAuth transaction is invalid or expired")
        throw createError({statusCode: 400, statusMessage: "OAuth transaction is invalid or expired"})
    }
    const {token, definition} = await exchangeCode(provider, code, transaction.codeVerifier)
    const profile = await definition.fetchProfile(token.access_token)
    const conflictingAccount = await db.providerAccounts.findOne({provider, externalAccountId: profile.id})
    if (
        transaction.linkingUserId &&
        conflictingAccount &&
        !conflictingAccount.userId.equals(transaction.linkingUserId)
    ) {
        logger.warn(
            "OAuth.finish",
            provider,
            `Provider account ${profile.id}`,
            "Account is already linked to another user"
        )
        throw createError({statusCode: 409, statusMessage: "This provider account is already linked to another user"})
    }
    const user = conflictingAccount
        ? await db.users.findOne({_id: conflictingAccount.userId}).then((value) => value!)
        : await findOrCreateUser(profile, transaction.linkingUserId)
    const now = new Date()
    await db.providerAccounts.updateOne(
        {provider, externalAccountId: profile.id},
        {
            $set: {
                userId: user._id!,
                email: profile.email?.trim().toLowerCase(),
                emailVerified: profile.emailVerified,
                displayName: profile.displayName,
                accessToken: await encryptSecret(token.access_token),
                ...(token.refresh_token ? {refreshToken: await encryptSecret(token.refresh_token)} : {}),
                tokenExpiresAt: token.expires_in ? new Date(now.getTime() + token.expires_in * 1000) : undefined,
                scopes: token.scope?.split(" ").filter(Boolean) || definition.scopes,
                connectedAt: now,
                updatedAt: now
            }
        },
        {upsert: true}
    )
    await createSession(event, user._id!)
    logger.info(
        "OAuth.finish",
        provider,
        `User ${user._id!.toHexString()}`,
        `Provider account ${profile.id}`,
        transaction.linkingUserId ? "Account linked" : "Login completed"
    )
    return transaction.redirectAfter
}
