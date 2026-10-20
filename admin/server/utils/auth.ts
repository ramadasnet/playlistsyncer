import {createHash, randomBytes} from "node:crypto"
import {createError, deleteCookie, getCookie, getHeader, getRequestURL, setCookie, type H3Event} from "h3"
import * as oauth from "oauth4webapi"
import {getDatabase} from "../../../server/utils/database"
import {adminConfig, isAllowedAdmin} from "./config"

const google: oauth.AuthorizationServer = {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs"
}
const cookieName = process.env.NODE_ENV === "production" ? "__Host-pls_admin" : "pls_admin"
const cookieOptions = {httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/"}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const randomToken = () => randomBytes(32).toString("base64url")

interface AdminSession {
    tokenHash: string
    email: string
    name: string
    expiresAt: Date
}
interface AdminLogin {
    stateHash: string
    browserHash: string
    verifier: string
    nonce: string
    expiresAt: Date
}

/** Require a live, independently scoped staff session on every request. */
export async function requireAdmin(event: H3Event) {
    const token = getCookie(event, cookieName)
    if (!token) throw createError({statusCode: 401, statusMessage: "Admin sign-in required"})
    const database = await getDatabase()
    const session = token ? await database.collection<AdminSession>("adminSessions").findOne({tokenHash: hash(token), expiresAt: {$gt: new Date()}}) : null
    if (!session || !isAllowedAdmin(session.email, true)) throw createError({statusCode: 401, statusMessage: "Admin sign-in required"})
    return {email: session.email, name: session.name}
}

/** Require the configured origin on every state-changing request. */
export function assertAdminOrigin(event: H3Event) {
    if (getHeader(event, "origin") !== adminConfig().url) throw createError({statusCode: 403, statusMessage: "Invalid admin request origin"})
}

/** Start a browser-bound, one-use Google authorization code flow. */
export async function beginAdminLogin(event: H3Event) {
    const config = adminConfig()
    if (!config.googleClientId || !config.googleClientSecret || !config.allowedEmails.length) throw createError({statusCode: 503, statusMessage: "Admin Google sign-in is not configured"})
    const state = randomToken()
    const browser = randomToken()
    const nonce = oauth.generateRandomNonce()
    const verifier = oauth.generateRandomCodeVerifier()
    const database = await getDatabase()
    await database.collection<AdminLogin>("adminLogins").insertOne({stateHash: hash(state), browserHash: hash(browser), nonce, verifier, expiresAt: new Date(Date.now() + 600_000)})
    setCookie(event, `pls_admin_oauth_${hash(state)}`, browser, {...cookieOptions, maxAge: 600})
    const url = new URL(google.authorization_endpoint!)
    url.search = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: `${config.url}/api/auth/callback`,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        prompt: "select_account"
    }).toString()
    return url.toString()
}

/** Validate Google identity, consume the transaction, and rotate the admin session. */
export async function finishAdminLogin(event: H3Event) {
    const config = adminConfig()
    const url = getRequestURL(event)
    const state = url.searchParams.get("state") || ""
    if (!/^[\w-]{43}$/.test(state)) throw createError({statusCode: 400, statusMessage: "Invalid sign-in state"})
    const browserCookie = `pls_admin_oauth_${hash(state)}`
    const browser = getCookie(event, browserCookie)
    deleteCookie(event, browserCookie, cookieOptions)
    const database = await getDatabase()
    const transaction = browser ? await database.collection<AdminLogin>("adminLogins").findOneAndDelete({stateHash: hash(state), browserHash: hash(browser), expiresAt: {$gt: new Date()}}) : null
    if (!transaction) throw createError({statusCode: 400, statusMessage: "Sign-in expired; please try again"})
    const client: oauth.Client = {client_id: config.googleClientId}
    const parameters = oauth.validateAuthResponse(google, client, url.searchParams, state)
    const response = await oauth.authorizationCodeGrantRequest(google, client, oauth.ClientSecretPost(config.googleClientSecret), parameters, `${config.url}/api/auth/callback`, transaction.verifier)
    const tokens = await oauth.processAuthorizationCodeResponse(google, client, response, {expectedNonce: transaction.nonce, requireIdToken: true})
    await oauth.validateApplicationLevelSignature(google, response)
    const claims = oauth.getValidatedIdTokenClaims(tokens)
    if (!claims || typeof claims.email !== "string" || !isAllowedAdmin(claims.email, claims.email_verified === true, config)) throw createError({statusCode: 403, statusMessage: "This Google account does not have admin access"})
    await endAdminSession(event)
    const token = randomToken()
    await database
        .collection<AdminSession>("adminSessions")
        .insertOne({tokenHash: hash(token), email: claims.email.toLowerCase(), name: typeof claims.name === "string" ? claims.name : claims.email, expiresAt: new Date(Date.now() + config.sessionHours * 3_600_000)})
    setCookie(event, cookieName, token, {...cookieOptions, maxAge: config.sessionHours * 3600})
}

/** Revoke the opaque staff session without touching consumer sessions. */
export async function endAdminSession(event: H3Event) {
    const token = getCookie(event, cookieName)
    if (token) await (await getDatabase()).collection("adminSessions").deleteOne({tokenHash: hash(token)})
    deleteCookie(event, cookieName, cookieOptions)
}
