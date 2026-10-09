// Implement OAuth login and provider-account linking with short-lived transactions.
import {createHash, randomBytes} from "node:crypto"
import type {H3Event} from "h3"
import {ObjectId} from "mongodb"
import {truncateDisplayName} from "../../../shared/display-name"
import type {Provider, UserDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {getServerConfig} from "../../utils/config"
import {fetchWithRetry} from "../../utils/fetch-retry"
import logger from "../../utils/logger"
import {isDuplicateKeyError} from "../../utils/mongodb"
import {decryptSecret, encryptSecret} from "../../utils/secrets"
import {getOAuthProvider, type OAuthProfile} from "./providers"
import {isProviderEnabled} from "../../utils/provider-availability"
import {createSession, getCurrentUser, hashOpaqueToken} from "./session"

// Build the callback URL registered for a provider.
function callbackUrl(provider: Provider): string {
    return `${getServerConfig().appUrl}/api/auth/${provider}/callback`
}

// Accept only safe local redirects after authentication.
function normalizeRedirect(value: unknown): string {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/sync"
}

// Create a PKCE OAuth transaction and return the provider authorization URL.
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
        // Store the PKCE verifier encrypted at rest alongside the challenge derived from its plaintext value.
        codeVerifier: await encryptSecret(codeVerifier),
        linkingUserId: currentUser?._id,
        redirectAfter: normalizeRedirect(getQuery(event).redirect),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000)
    })
    logger.info("OAuth.begin", provider, currentUser?._id ? `Linking user ${currentUser._id.toHexString()}` : "New login")

    const url = new URL(definition.authorizeUrl)
    url.searchParams.set("client_id", definition.clientId)
    url.searchParams.set("redirect_uri", callbackUrl(provider))
    url.searchParams.set("response_type", "code")
    // SoundCloud documents no OAuth scopes, so an empty list omits the parameter.
    if (definition.scopes.length) {
        url.searchParams.set("scope", definition.scopes.join(" "))
    }
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge", challenge)
    url.searchParams.set("code_challenge_method", "S256")
    if (provider === "youtube") {
        url.searchParams.set("access_type", "offline")
        url.searchParams.set("prompt", "consent")
    }
    return url.toString()
}

// Exchange an authorization code for provider access tokens.
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
        headers.set("Authorization", `Basic ${Buffer.from(`${definition.clientId}:${definition.clientSecret}`).toString("base64")}`)
    } else {
        body.set("client_id", definition.clientId)
        body.set("client_secret", definition.clientSecret)
    }
    const response = await fetchWithRetry(definition.tokenUrl, {method: "POST", headers, body}, {label: "OAuth.exchangeCode"})
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

// Verify that a provider supplied a trusted email address.
export function hasVerifiedProviderEmail(profile: Pick<OAuthProfile, "email" | "emailVerified">): boolean {
    return Boolean(profile.email?.trim() && profile.emailVerified)
}

// Construct a new local user from an OAuth profile.
export function newUserFromOAuthProfile(profile: OAuthProfile, now: Date): UserDocument {
    const email = hasVerifiedProviderEmail(profile) ? profile.email!.trim().toLowerCase() : undefined
    return {
        ...(email ? {email} : {}),
        displayName: truncateDisplayName(profile.displayName) || "Anonymous",
        avatarUrl: profile.avatarUrl,
        tier: "free",
        createdAt: now,
        updatedAt: now
    }
}

// Select the post-login destination based on email completion.
export function oauthRedirectAfterLogin(user: Pick<UserDocument, "email" | "tempEmail">, redirectAfter: string): string {
    return user.email || user.tempEmail ? redirectAfter : "/account"
}

// Reuse a matching user or create one for a first-time provider login.
async function findOrCreateUser(profile: OAuthProfile, linkingUserId?: ObjectId) {
    const db = await collections()
    if (linkingUserId) {
        const linkedUser = await db.users.findOne({_id: linkingUserId})
        if (!linkedUser) {
            logger.warn("OAuth.findOrCreateUser", `Linking user ${linkingUserId.toHexString()}`, "User no longer exists")
            throw createError({statusCode: 401, statusMessage: "Linking session is no longer valid"})
        }
        logger.info("OAuth.findOrCreateUser", `Linking existing user ${linkingUserId.toHexString()}`)
        return linkedUser
    }
    if (hasVerifiedProviderEmail(profile)) {
        const email = profile.email!.trim().toLowerCase()
        const existingUser = await db.users.findOne({email})
        if (existingUser) {
            logger.info("OAuth.findOrCreateUser", `Matched existing user ${existingUser._id!.toHexString()}`)
            return existingUser
        }
    } else {
        logger.info("OAuth.findOrCreateUser", `Provider account ${profile.id}`, "Provider email unavailable")
    }
    const now = new Date()
    const result = await db.users.insertOne(newUserFromOAuthProfile(profile, now))
    logger.info("OAuth.findOrCreateUser", `Created user ${result.insertedId.toHexString()}`, hasVerifiedProviderEmail(profile) ? "Login completed" : "Email capture required")
    return db.users.findOne({_id: result.insertedId}).then((user) => user!)
}

// Attach a newly verified provider email to an account that lacks one.
async function assignVerifiedProviderEmail(user: UserDocument, profile: OAuthProfile): Promise<UserDocument> {
    if (user.email || !hasVerifiedProviderEmail(profile)) {
        return user
    }
    const email = profile.email!.trim().toLowerCase()
    const db = await collections()
    const taken = await db.users.findOne({email})
    if (taken) {
        return user
    }
    try {
        const now = new Date()
        await db.users.updateOne(
            {_id: user._id},
            {
                $set: {email, updatedAt: now},
                $unset: {
                    tempEmail: "" as const,
                    emailVerificationTokenHash: "" as const,
                    emailVerificationExpiresAt: "" as const,
                    emailConfirmationSentAt: "" as const
                }
            }
        )
        logger.info("OAuth.assignEmail", `User ${user._id!.toHexString()}`, "Assigned verified provider email")
        return {...user, email, tempEmail: undefined}
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return user
        }
        throw error
    }
}

// Consume the OAuth transaction, persist the account, and establish a session.
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
    const codeVerifier = await decryptSecret(transaction.codeVerifier)
    const {token, definition} = await exchangeCode(provider, code, codeVerifier)
    const profile = await definition.fetchProfile(token.access_token)
    const accountIds = [profile.id, ...(profile.previousIds || [])]
    const storedAccounts = await db.providerAccounts.find({provider, externalAccountId: {$in: accountIds}}).toArray()
    const conflictingAccount = storedAccounts.find((account) => account.externalAccountId === profile.id) || storedAccounts[0]
    if (transaction.linkingUserId && conflictingAccount && !conflictingAccount.userId.equals(transaction.linkingUserId)) {
        logger.warn("OAuth.finish", provider, `Provider account ${profile.id}`, "Account is already linked to another user")
        throw createError({statusCode: 409, statusMessage: "This provider account is already linked to another user"})
    }
    let user: UserDocument = conflictingAccount ? await db.users.findOne({_id: conflictingAccount.userId}).then((value) => value!) : await findOrCreateUser(profile, transaction.linkingUserId)
    const anotherProviderAccount = await db.providerAccounts.findOne({userId: user._id!, provider, externalAccountId: {$nin: accountIds}})
    if (anotherProviderAccount) {
        logger.warn("OAuth.finish", provider, `User ${user._id!.toHexString()}`, "Another account from this provider is already linked")
        throw createError({statusCode: 409, statusMessage: "Only one account per music provider can be connected"})
    }
    user = await assignVerifiedProviderEmail(user, profile)
    const now = new Date()
    // Updating the stored account by _id re-keys an account stored under a previous provider id.
    await db.providerAccounts.updateOne(
        conflictingAccount ? {_id: conflictingAccount._id} : {provider, externalAccountId: profile.id},
        {
            $set: {
                provider,
                externalAccountId: profile.id,
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
    logger.info("OAuth.finish", provider, `User ${user._id!.toHexString()}`, `Provider account ${profile.id}`, transaction.linkingUserId ? "Account linked" : "Login completed")
    return oauthRedirectAfterLogin(user, transaction.redirectAfter)
}
