// In-memory bridge between sync code and the browser extensions that run provider requests in each user's own browser.
// The queue lives in this process, so the website must run as a single instance.
import {randomUUID} from "node:crypto"
import {createError} from "h3"
import {providerDisplayNames} from "~~/shared/types/domain"
import type {ExtensionCommand, ExtensionCommandMap, ExtensionCommandMethod, ExtensionCommandResult, ExtensionProvider, ExtensionProviderAccount} from "~~/shared/types/extension"
import logger from "../../utils/logger"

// A poll within this window means the extension is online.
export const extensionOnlineWindowMs = 60 * 1000
// How long one poll request waits for a command before it answers empty. Bun closes idle requests after 10 seconds.
export const extensionPollWaitMs = 8 * 1000
// A delivered command without a result after this long fails.
const commandTimeoutMs = 10 * 60 * 1000
// A client that stops polling this long loses its delivered commands.
const clientGoneMs = 90 * 1000
const sweepIntervalMs = 30 * 1000

interface BridgeClient {
    clientId: string
    userId: string
    accounts: ExtensionProviderAccount[]
    lastSeenAt: number
    wake?: () => void
}

interface PendingCommand {
    command: ExtensionCommand
    userId: string
    // Set when a poll delivered the command to this client.
    clientId?: string
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

const clients = new Map<string, BridgeClient>()
const pending = new Map<string, PendingCommand>()
let sweepTimer: ReturnType<typeof setInterval> | undefined

// Start the periodic sweep that fails commands held by extensions that went away.
function ensureSweep() {
    if (sweepTimer) {
        return
    }
    sweepTimer = setInterval(sweepGoneClients, sweepIntervalMs)
    sweepTimer.unref?.()
}

// Drop clients that stopped polling and fail the commands they still hold.
function sweepGoneClients() {
    const now = Date.now()
    for (const client of clients.values()) {
        if (now - client.lastSeenAt > clientGoneMs) {
            dropClient(client.clientId, "The browser extension went offline before it finished")
        }
    }
}

// Forget a client and fail the commands it holds.
function dropClient(clientId: string, reason: string) {
    clients.get(clientId)?.wake?.()
    clients.delete(clientId)
    for (const entry of [...pending.values()]) {
        if (entry.clientId === clientId) {
            settle(entry.command.id, {id: entry.command.id, ok: false, error: {message: reason, code: "failed"}})
        }
    }
}

// Check whether a client matches the provider account that a command targets.
function clientServes(client: BridgeClient, provider: ExtensionProvider, accountId?: string) {
    return client.accounts.some((account) => account.provider === provider && (!accountId || account.accountId === accountId))
}

// List the online clients of one user.
function onlineClients(userId: string, now = Date.now()) {
    return [...clients.values()].filter((client) => client.userId === userId && now - client.lastSeenAt <= extensionOnlineWindowMs)
}

// True when an extension of the user is online, optionally signed in to one provider account.
export function isExtensionOnline(userId: string, provider?: ExtensionProvider, accountId?: string): boolean {
    return onlineClients(userId).some((client) => !provider || clientServes(client, provider, accountId))
}

// True when the given client polled recently.
export function isExtensionClientOnline(clientId: string): boolean {
    const client = clients.get(clientId)
    return Boolean(client && Date.now() - client.lastSeenAt <= extensionOnlineWindowMs)
}

// The message shown when a task or request needs the browser extension.
export function extensionOfflineMessage(provider?: ExtensionProvider) {
    return `Open PlaylistSyncer or the browser extension popup${provider ? ` and sign in to ${providerDisplayNames[provider]}` : ""} to continue`
}

// Record a poll from a client and the provider accounts it reported.
export function registerExtensionPoll(clientId: string, userId: string, accounts: ExtensionProviderAccount[]) {
    ensureSweep()
    const client = clients.get(clientId)
    if (client) {
        client.accounts = accounts
        client.lastSeenAt = Date.now()
        return
    }
    clients.set(clientId, {clientId, userId, accounts, lastSeenAt: Date.now()})
}

// Forget a client after its token was revoked.
export function unregisterExtensionClient(clientId: string) {
    dropClient(clientId, "The browser extension was disconnected")
}

// Hand queued commands that this client can run to it.
function claimCommands(client: BridgeClient): ExtensionCommand[] {
    const claimed: ExtensionCommand[] = []
    for (const entry of pending.values()) {
        if (!entry.clientId && entry.userId === client.userId && clientServes(client, entry.command.provider, entry.command.accountId)) {
            entry.clientId = client.clientId
            claimed.push(entry.command)
        }
    }
    return claimed
}

// Wait up to the poll window for commands for this client.
export async function takeExtensionCommands(clientId: string, signal?: AbortSignal): Promise<ExtensionCommand[]> {
    const client = clients.get(clientId)
    if (!client || signal?.aborted) {
        return []
    }
    const ready = claimCommands(client)
    if (ready.length) {
        return ready
    }
    // A newer poll from the same client ends the older one.
    client.wake?.()
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", done)
            if (client.wake === done) {
                client.wake = undefined
            }
            resolve()
        }
        const timer = setTimeout(done, extensionPollWaitMs)
        client.wake = done
        signal?.addEventListener("abort", done)
    })
    if (signal?.aborted || clients.get(clientId) !== client) {
        return []
    }
    client.lastSeenAt = Date.now()
    return claimCommands(client)
}

// Map an extension error to the HTTP error that sync code already understands.
function commandError(command: ExtensionCommand, error: NonNullable<ExtensionCommandResult["error"]>) {
    const label = providerDisplayNames[command.provider]
    const message = String(error.message || "Unknown error").slice(0, 200)
    if (error.code === "auth") {
        return createError({statusCode: 409, statusMessage: `Sign in to ${label} in your browser so the PlaylistSyncer extension can continue`})
    }
    if (error.code === "rate_limit") {
        return createError({statusCode: 429, statusMessage: `${command.provider} API request failed (429)`})
    }
    // The sync engine recognizes this message as a missing playlist.
    if (error.code === "not_found") {
        return createError({statusCode: 502, statusMessage: `${command.provider} API request failed (404)`})
    }
    if (error.code === "unsupported") {
        return createError({statusCode: 501, statusMessage: message})
    }
    return createError({statusCode: 502, statusMessage: `${label} request in the browser extension failed: ${message}`})
}

// Resolve or reject one pending command.
function settle(id: string, result: ExtensionCommandResult) {
    const entry = pending.get(id)
    if (!entry) {
        return false
    }
    pending.delete(id)
    clearTimeout(entry.timer)
    if (result.ok) {
        entry.resolve(result.result ?? null)
        return true
    }
    const error = result.error || {message: "Unknown error", code: "failed" as const}
    logger.warn("ExtensionBridge.result", entry.command.provider, entry.command.method, `User ${entry.userId}`, error.code || "failed", error.message)
    entry.reject(commandError(entry.command, error))
    return true
}

// Accept command results from a client. Results for commands that it does not hold are ignored.
export function submitExtensionResults(clientId: string, results: ExtensionCommandResult[]) {
    let accepted = 0
    for (const result of results) {
        if (result && typeof result.id === "string" && pending.get(result.id)?.clientId === clientId && settle(result.id, result)) {
            accepted++
        }
    }
    const client = clients.get(clientId)
    if (client) {
        client.lastSeenAt = Date.now()
    }
    return accepted
}

// Queue a provider request for the user's extension and wait for its result.
export function sendExtensionCommand<M extends ExtensionCommandMethod>(userId: string, provider: ExtensionProvider, accountId: string, method: M, args: ExtensionCommandMap[M]["args"]): Promise<ExtensionCommandMap[M]["result"]> {
    if (!isExtensionOnline(userId, provider, accountId)) {
        return Promise.reject(createError({statusCode: 409, statusMessage: extensionOfflineMessage(provider)}))
    }
    ensureSweep()
    const command = {id: randomUUID(), provider, accountId, method, args} as ExtensionCommand
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(command.id, {id: command.id, ok: false, error: {message: "The browser extension did not answer in time", code: "failed"}}), commandTimeoutMs)
        timer.unref?.()
        pending.set(command.id, {command, userId, resolve: resolve as (value: unknown) => void, reject, timer})
        for (const client of onlineClients(userId)) {
            if (clientServes(client, provider, accountId)) {
                client.wake?.()
            }
        }
    })
}
