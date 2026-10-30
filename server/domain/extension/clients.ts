// Link browser extensions to users, authenticate their requests, and keep their provider accounts and due tasks in step.
import {createHash, randomBytes, timingSafeEqual} from "node:crypto"
import type {H3Event} from "h3"
import type {ObjectId} from "mongodb"
import type {ExtensionClientDocument, ProviderAccountDocument} from "~~/shared/types/domain"
import {isExtensionProvider, type ExtensionProviderAccount} from "~~/shared/types/extension"
import {collections} from "../../data/collections"
import {getServerConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {startTrackedSyncRun} from "../../utils/shutdown"
import {hashOpaqueToken} from "../auth/session"
import {beginSyncTask, completeSyncTask} from "../sync/engine"
import {idleLeaseFilter} from "../sync/task-activity"
import {extensionOfflineMessage, isExtensionOnline, unregisterExtensionClient} from "./bridge"

const authorizationCodeTtlMs = 5 * 60 * 1000
const lastSeenWriteIntervalMs = 60 * 1000
const dueTaskCheckIntervalMs = 60 * 1000

const lastSeenWrites = new Map<string, number>()
const dueTaskChecks = new Map<string, number>()
const runningDueTasks = new Set<string>()

// The extension feature is on when at least one extension redirect URI is allowed.
export function isExtensionEnabled() {
    return getServerConfig().extensionRedirectUris.length > 0
}

// Reject requests when the extension feature is off.
export function requireExtensionEnabled() {
    if (!isExtensionEnabled()) {
        throw createError({statusCode: 404, statusMessage: "The browser extension is not enabled"})
    }
}

// Check a redirect URI against the exact allowlist.
export function isAllowedRedirectUri(redirectUri: string) {
    return getServerConfig().extensionRedirectUris.includes(redirectUri)
}

// Create a one-time authorization code bound to the PKCE challenge and redirect URI.
export async function createExtensionAuthorizationCode(input: {userId: ObjectId; redirectUri: string; codeChallenge: string; browser: ExtensionClientDocument["browser"]}) {
    const code = randomBytes(32).toString("base64url")
    const now = new Date()
    const db = await collections()
    await db.extensionAuthCodes.insertOne({
        userId: input.userId,
        codeHash: hashOpaqueToken(code),
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        browser: input.browser,
        expiresAt: new Date(now.getTime() + authorizationCodeTtlMs),
        createdAt: now
    })
    logger.info("Extension.authorize", `User ${input.userId.toHexString()}`, input.browser)
    return code
}

// Compare two strings in constant time.
function safeEqual(left: string, right: string) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}

// Redeem an authorization code once and issue a bearer token for the extension.
export async function exchangeExtensionAuthorizationCode(input: {code: string; codeVerifier: string; redirectUri: string; version?: string}) {
    const db = await collections()
    const record = await db.extensionAuthCodes.findOneAndDelete({codeHash: hashOpaqueToken(input.code)})
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url")
    if (!record || record.expiresAt.getTime() < Date.now() || record.redirectUri !== input.redirectUri || !safeEqual(record.codeChallenge, challenge)) {
        logger.warn("Extension.token", "Invalid or expired authorization code")
        throw createError({statusCode: 400, statusMessage: "invalid_grant"})
    }
    const user = await db.users.findOne({_id: record.userId})
    if (!user) {
        throw createError({statusCode: 400, statusMessage: "invalid_grant"})
    }
    const token = randomBytes(32).toString("base64url")
    const now = new Date()
    await db.extensionClients.insertOne({userId: user._id!, tokenHash: hashOpaqueToken(token), browser: record.browser, ...(input.version ? {version: input.version} : {}), lastSeenAt: now, createdAt: now})
    logger.info("Extension.token", `User ${user._id!.toHexString()}`, record.browser)
    return {token, user}
}

// Authenticate an extension request by its bearer token. Cookies are never read here.
export async function requireExtensionClient(event: H3Event) {
    requireExtensionEnabled()
    const header = getHeader(event, "authorization") || ""
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
    if (!token) {
        throw createError({statusCode: 401, statusMessage: "Extension token required"})
    }
    const db = await collections()
    const client = await db.extensionClients.findOne({tokenHash: hashOpaqueToken(token)})
    const user = client ? await db.users.findOne({_id: client.userId}) : null
    if (!client || !user) {
        throw createError({statusCode: 401, statusMessage: "Extension token revoked"})
    }
    return {client, user}
}

// Persist the client's last poll time, at most once a minute.
export async function touchExtensionClient(client: ExtensionClientDocument, version?: string) {
    const key = client._id!.toHexString()
    const now = Date.now()
    if (now - (lastSeenWrites.get(key) || 0) < lastSeenWriteIntervalMs) {
        return
    }
    lastSeenWrites.set(key, now)
    const db = await collections()
    await db.extensionClients.updateOne({_id: client._id!}, {$set: {lastSeenAt: new Date(now), ...(version ? {version} : {})}})
}

// Revoke one linked browser and fail the commands it still holds.
export async function revokeExtensionClient(userId: ObjectId, clientId: ObjectId) {
    const db = await collections()
    const result = await db.extensionClients.deleteOne({_id: clientId, userId})
    unregisterExtensionClient(clientId.toHexString())
    lastSeenWrites.delete(clientId.toHexString())
    logger.info("Extension.revoke", `User ${userId.toHexString()}`, `Client ${clientId.toHexString()}`, result.deletedCount ? "Revoked" : "Already gone")
    return result.deletedCount > 0
}

// Create or refresh the provider accounts that the extension found signed in, unless the user connected that provider with OAuth.
export async function upsertExtensionAccounts(userId: ObjectId, accounts: ExtensionProviderAccount[]) {
    const db = await collections()
    for (const account of accounts) {
        if (!isExtensionProvider(account.provider) || !account.accountId) {
            continue
        }
        const externalAccountId = `browser:${userId.toHexString()}:${account.provider}`
        const existing = await db.providerAccounts.find({userId, provider: account.provider}).toArray()
        if (existing.some((connected) => connected.connection !== "extension")) {
            continue
        }
        const current = existing.find((connected) => connected.externalAccountId === externalAccountId)
        const displayName = String(account.displayName || account.accountId).slice(0, 200)
        if (current && current.extensionAccountId === account.accountId && current.displayName === displayName) {
            continue
        }
        const now = new Date()
        await db.providerAccounts.updateOne(
            {provider: account.provider, externalAccountId},
            {
                $set: {displayName, extensionAccountId: account.accountId, connection: "extension", updatedAt: now},
                $setOnInsert: {userId, provider: account.provider, externalAccountId, emailVerified: false, scopes: [], connectedAt: now} satisfies Partial<ProviderAccountDocument>
            },
            {upsert: true}
        )
        logger.info("Extension.account", account.provider, `User ${userId.toHexString()}`, current ? "Updated" : "Connected")
    }
}

// Reject an action when the browser extension that serves these accounts is not online.
export function assertExtensionAccountsOnline(accounts: ProviderAccountDocument[]) {
    for (const account of accounts) {
        if (account.connection !== "extension") {
            continue
        }
        if (!isExtensionProvider(account.provider) || !isExtensionOnline(account.userId.toHexString(), account.provider, account.extensionAccountId)) {
            throw createError({statusCode: 409, statusMessage: extensionOfflineMessage(isExtensionProvider(account.provider) ? account.provider : undefined)})
        }
    }
}

// Run the user's due extension tasks one after another while their extension is online. Checks at most once a minute per user.
export function runDueExtensionTasks(userId: ObjectId) {
    const key = userId.toHexString()
    const now = Date.now()
    if (runningDueTasks.has(key) || now - (dueTaskChecks.get(key) || 0) < dueTaskCheckIntervalMs) {
        return
    }
    dueTaskChecks.set(key, now)
    runningDueTasks.add(key)
    void (async () => {
        try {
            const db = await collections()
            const date = new Date()
            const tasks = await db.syncTasks
                .find({userId, browserExtension: true, status: {$in: ["active", "needs_attention"]}, nextRunAt: {$lte: date}, ...idleLeaseFilter(date)})
                .sort({nextRunAt: 1})
                .limit(10)
                .toArray()
            for (const task of tasks) {
                const accounts = await db.providerAccounts.find({_id: {$in: [task.source.providerAccountId, task.destination.providerAccountId]}, userId}).toArray()
                try {
                    assertExtensionAccountsOnline(accounts)
                    logger.info("Extension.dueTask", `Task ${task._id!.toHexString()}`, `User ${key}`)
                    const {finished} = await startTrackedSyncRun(() => beginSyncTask(task._id!, "scheduled"), completeSyncTask)
                    await finished
                } catch (error) {
                    logger.warn("Extension.dueTask", `Task ${task._id!.toHexString()}`, `User ${key}`, error)
                }
            }
        } catch (error) {
            logger.error("Extension.dueTasks", `User ${key}`, error)
        } finally {
            runningDueTasks.delete(key)
        }
    })()
}
