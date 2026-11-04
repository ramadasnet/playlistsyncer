// Background service worker (Chrome) / event page (Firefox): links the extension to PlaylistSyncer and runs the queued provider commands.
import {
    extensionScheduledPollIntervalMs,
    type ExtensionCommand,
    type ExtensionCommandResult,
    type ExtensionMeResponse,
    type ExtensionPollRequest,
    type ExtensionPollResponse,
    type ExtensionProvider,
    type ExtensionProviderAccount,
    type ExtensionTokenRequest,
    type ExtensionTokenResponse
} from "../../shared/types/extension"
import type {PopupMessage, PopupState} from "./messages"
import {connectors, getConnector} from "./providers"
import {ProviderError, type ProviderConnector} from "./providers/types"
import {closeIdleTabs, hasProviderTab, tabsCleanupAlarm} from "./tabs"
import {errorMessage, getLocal, setLocal, sleep} from "./util"

interface Link {
    token: string
    user: ExtensionTokenResponse["user"]
}

interface ProviderStatus {
    account?: ExtensionProviderAccount
    error?: string
    checkedAt: number
    stale?: boolean
}

type AccountCache = Partial<Record<ExtensionProvider, ProviderStatus>>

const serverUrl = PLS_EXTENSION_SERVER_URL.replace(/\/+$/, "")
const sitePatterns = [`${new URL(serverUrl).origin}/*`]
const detectIntervalMs = 15 * 60_000
const idleThresholdSec = 60
const interactiveWindowMs = 60_000
const scheduledPollAlarm = "playlistsyncer-scheduled"
const scheduledPollIntervalMinutes = extensionScheduledPollIntervalMs / 60_000
const maxPerProvider = 2
const activeCommands = new Set<string>()
const slots: Partial<Record<ExtensionProvider, {active: number; waiting: (() => void)[]}>> = {}
const detecting = new Map<ExtensionProvider, Promise<ProviderStatus>>()
let accountCache: AccountCache | undefined
let polling = false
let interactiveUntil = 0
let me: ExtensionMeResponse | undefined
let lastError: string | undefined

class UnauthorizedError extends Error {}

// Keep the background alive while a poll session or the linking flow runs; extension API calls reset the idle timer.
function keepAlive(): () => void {
    const timer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
    return () => clearInterval(timer)
}

// Call the PlaylistSyncer extension API with the stored bearer token; a 401 unlinks the extension.
async function api<T>(path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const link = await getLocal<Link>("link")
    if (!link) throw new UnauthorizedError("Not linked")
    const headers: Record<string, string> = {authorization: `Bearer ${link.token}`}
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await fetch(`${serverUrl}${path}`, {method: body === undefined ? "GET" : "POST", credentials: "omit", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)})
    if (res.status === 401) {
        if ((await getLocal<Link>("link"))?.token === link.token) await unlink()
        throw new UnauthorizedError("PlaylistSyncer revoked the extension access")
    }
    if (!res.ok) throw new Error(`PlaylistSyncer request failed (HTTP ${res.status})`)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
}

// Forget the PlaylistSyncer link and the scheduling state bound to it, so a fresh link starts without inherited gates.
async function unlink(): Promise<void> {
    me = undefined
    interactiveUntil = 0
    await chrome.storage.local.remove(["link", "lastScheduledPollAt"])
}

// Random URL-safe string from crypto.getRandomValues.
function randomString(length: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => chars[b & 63]).join("")
}

// Base64url encoding without padding.
function base64url(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

// Link the extension with OAuth 2.0 authorization code + PKCE through the browser identity flow.
async function connect(): Promise<void> {
    const release = keepAlive()
    try {
        const redirectUri = chrome.identity.getRedirectURL()
        const verifier = randomString(64)
        const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
        const state = randomString(32)
        const url = `${serverUrl}/extension/connect?redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&browser=${PLS_BROWSER}`
        const responseUrl = await chrome.identity.launchWebAuthFlow({url, interactive: true})
        if (!responseUrl) throw new Error("Linking was cancelled")
        const params = new URL(responseUrl).searchParams
        const error = params.get("error")
        if (error) throw new Error(error === "access_denied" ? "Access was denied" : `Linking failed: ${error}`)
        const code = params.get("code")
        if (!code || params.get("state") !== state) throw new Error("Invalid linking response")
        const body: ExtensionTokenRequest = {grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, version: chrome.runtime.getManifest().version}
        const res = await fetch(`${serverUrl}/api/extension/token`, {method: "POST", credentials: "omit", headers: {"content-type": "application/json"}, body: JSON.stringify(body)})
        if (!res.ok) throw new Error(`Linking failed (HTTP ${res.status})`)
        const token = (await res.json()) as ExtensionTokenResponse
        await setLocal({link: {token: token.access_token, user: token.user} satisfies Link})
        void pollLoop()
    } finally {
        release()
    }
}

// Revoke the token on the server (best effort) and forget the link.
async function disconnect(): Promise<void> {
    await api("/api/extension/disconnect", {}).catch(() => undefined)
    await unlink()
}

// Cached provider statuses, loaded once from storage.
async function accounts(): Promise<AccountCache> {
    accountCache ??= (await getLocal<AccountCache>("accounts")) ?? {}
    return accountCache
}

// Save a provider status in the cache.
async function saveStatus(provider: ExtensionProvider, status: ProviderStatus): Promise<void> {
    const cache = await accounts()
    cache[provider] = status
    await setLocal({accounts: cache})
}

// Detect the signed-in account of one provider (one detection at a time per provider).
function detect(connector: ProviderConnector): Promise<ProviderStatus> {
    const pending = detecting.get(connector.provider)
    if (pending) return pending
    const next = (async () => {
        const previous = (await accounts())[connector.provider]
        let status: ProviderStatus
        try {
            status = {account: (await connector.detectAccount()) ?? undefined, checkedAt: Date.now()}
        } catch (err) {
            // Keep the previous account on unexpected errors, so a provider API change does not unlink it.
            status = {account: err instanceof ProviderError && err.code === "auth" ? undefined : previous?.account, error: errorMessage(err), checkedAt: Date.now()}
        }
        await saveStatus(connector.provider, status)
        return status
    })().finally(() => detecting.delete(connector.provider))
    detecting.set(connector.provider, next)
    return next
}

// Re-detect accounts. Without force, stale or unknown providers are always detected, which may open an inactive provider tab, so this only runs inside an authorized poll session. Known providers are re-detected at most every 15 minutes and only when a provider tab is already open.
async function refreshAccounts(force: boolean): Promise<AccountCache> {
    const cache = await accounts()
    await Promise.all(
        connectors.map(async (connector) => {
            const status = cache[connector.provider]
            if (force || !status || status.stale) return detect(connector)
            if (Date.now() - status.checkedAt < detectIntervalMs) return
            if (await hasProviderTab(connector.tabPatterns)) return detect(connector)
            await saveStatus(connector.provider, {...status, checkedAt: Date.now()})
        })
    )
    return cache
}

// Mark a provider for re-detection after an auth error.
async function markStale(provider: ExtensionProvider): Promise<void> {
    const status = (await accounts())[provider]
    if (status) await saveStatus(provider, {...status, stale: true})
}

// Wait for a free command slot of the provider.
async function acquire(provider: ExtensionProvider): Promise<void> {
    const slot = (slots[provider] ??= {active: 0, waiting: []})
    if (slot.active < maxPerProvider) {
        slot.active++
        return
    }
    await new Promise<void>((resolve) => slot.waiting.push(resolve))
}

// Hand the slot to the next waiting command, or free it.
function release(provider: ExtensionProvider): void {
    const slot = slots[provider]!
    const next = slot.waiting.shift()
    if (next) next()
    else slot.active--
}

// Run a command with the provider connector, after checking the signed-in account matches.
async function execute(command: ExtensionCommand): Promise<unknown> {
    const connector = getConnector(command.provider)
    const method = connector?.[command.method] as ((args: unknown) => Promise<unknown>) | undefined
    if (!connector || !method) throw new ProviderError(`${command.provider}.${command.method} is not supported`, "unsupported")
    let status = (await accounts())[command.provider]
    if (status?.account?.accountId !== command.accountId) status = await detect(connector)
    if (!status.account) throw new ProviderError(`Not signed in to ${connector.name}`, "auth")
    if (status.account.accountId !== command.accountId) throw new ProviderError(`Signed in to ${connector.name} as ${status.account.displayName}, not the linked account`, "auth")
    return method.call(connector, command.args)
}

// Send a command result, retrying a few times on errors.
async function sendResult(result: ExtensionCommandResult): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await api("/api/extension/results", {results: [result]})
            return
        } catch (err) {
            if (err instanceof UnauthorizedError) return
            console.warn("PlaylistSyncer: failed to send result", result.id, errorMessage(err))
            await sleep(2000 * attempt)
        }
    }
}

// Run one command (max 2 in flight per provider) and send its result as soon as it finishes.
async function runCommand(command: ExtensionCommand): Promise<void> {
    if (activeCommands.has(command.id)) return
    activeCommands.add(command.id)
    let result: ExtensionCommandResult
    await acquire(command.provider)
    try {
        result = {id: command.id, ok: true, result: (await execute(command)) ?? null}
    } catch (err) {
        const code = err instanceof ProviderError ? err.code : "failed"
        if (code === "auth") await markStale(command.provider)
        result = {id: command.id, ok: false, error: {message: errorMessage(err).slice(0, 1000), code}}
    } finally {
        release(command.provider)
    }
    await sendResult(result)
    activeCommands.delete(command.id)
}

// True while the PlaylistSyncer website is the active tab of a browser window that is actually focused; background site tabs and an unfocused browser do not count as interaction.
async function siteTabActive(): Promise<boolean> {
    const win = await chrome.windows.getLastFocused().catch(() => undefined)
    if (!win?.focused) return false
    return (await chrome.tabs.query({active: true, lastFocusedWindow: true, url: sitePatterns})).length > 0
}

// True while explicit website or popup use keeps polling live.
async function interactive(): Promise<boolean> {
    return Date.now() < interactiveUntil || (await siteTabActive())
}

// The automatic scheduled check may run only while the system is idle or locked, and at most every 30 minutes.
async function scheduledCheckDue(): Promise<boolean> {
    if ((await chrome.idle.queryState(idleThresholdSec)) === "active") return false
    const last = (await getLocal<number>("lastScheduledPollAt")) ?? 0
    return Date.now() - last >= extensionScheduledPollIntervalMs
}

// Start polling for the automatic scheduled check when it is idle and due; wakeups while the user is active never reach the network.
async function checkScheduledPoll(): Promise<void> {
    if ((await getLocal<Link>("link")) && (await scheduledCheckDue())) void pollLoop()
}

// Start polling while the website is the active tab of the focused window, so site work never waits for the scheduled cadence.
async function checkSiteActive(): Promise<void> {
    if ((await getLocal<Link>("link")) && (await siteTabActive())) void pollLoop()
}

// Start polling after a wakeup only when something allows it: active website use or a due idle scheduled check.
async function checkWake(): Promise<void> {
    if (!(await getLocal<Link>("link")) || polling) return
    if ((await siteTabActive()) || (await scheduledCheckDue())) void pollLoop()
}

// Long-poll the server while there is a reason to: a due idle scheduled check, commands in flight, or fresh website/popup interaction. Exits when nothing remains instead of polling forever.
async function pollLoop(): Promise<void> {
    if (polling) return
    polling = true
    const release = keepAlive()
    let backoff = 5_000
    let failures = 0
    let busy = false
    try {
        while (await getLocal<Link>("link")) {
            // Poll only while something authorizes it: a due idle scheduled check, work in flight, or fresh interaction.
            let runScheduled = await scheduledCheckDue()
            if (!runScheduled && !busy && !activeCommands.size && !(await interactive())) break
            const cache = await refreshAccounts(false)
            // Detection can take tens of seconds, so authorization is checked again before any request: a user who resumed meanwhile gets no new scheduled batch, only live work continues.
            runScheduled = await scheduledCheckDue()
            if (!runScheduled && !busy && !activeCommands.size && !(await interactive())) break
            if (runScheduled) {
                // The check timestamp and the alarm anchor to the actual send, so restarts and delayed wakeups cannot shift the cadence.
                const checkedAt = Date.now()
                await setLocal({lastScheduledPollAt: checkedAt})
                await chrome.alarms.create(scheduledPollAlarm, {when: checkedAt + extensionScheduledPollIntervalMs, periodInMinutes: scheduledPollIntervalMinutes})
            }
            try {
                const body: ExtensionPollRequest = {
                    version: chrome.runtime.getManifest().version,
                    browser: PLS_BROWSER,
                    accounts: Object.values(cache).flatMap((s) => (s?.account ? [{...s.account, displayName: s.account.displayName.slice(0, 200)}] : [])),
                    runScheduled
                }
                const response = await api<ExtensionPollResponse>("/api/extension/poll", body, 30_000)
                backoff = 5_000
                failures = 0
                busy = !!response?.busy
                const commands = response?.commands ?? []
                for (const command of commands) void runCommand(command)
                if (!commands.length && !busy && !activeCommands.size && !(await interactive())) break
                if (!commands.length && response?.retryAfterMs) await sleep(response.retryAfterMs)
            } catch (err) {
                if (err instanceof UnauthorizedError) break
                console.warn("PlaylistSyncer: poll failed", errorMessage(err))
                // An idle check with nothing left to do stops at the first error instead of retrying forever; work in flight gets bounded retries.
                failures++
                if (failures >= 6 || (!busy && !activeCommands.size && !(await interactive()))) break
                await sleep(backoff)
                backoff = Math.min(backoff * 2, 60_000)
            }
        }
    } finally {
        release()
        polling = false
    }
}

// Close provider tabs that went idle, but postpone while commands may still use them.
async function cleanupTabs(): Promise<void> {
    if (activeCommands.size) {
        await chrome.alarms.create(tabsCleanupAlarm, {delayInMinutes: 2})
        return
    }
    await closeIdleTabs()
}

// Build the popup state, optionally re-detecting accounts and reloading the tasks.
async function popupState(refresh: boolean): Promise<PopupState> {
    // Accounts are only detected while linked, so an unlinked extension never opens provider tabs.
    if (refresh && (await getLocal<Link>("link"))) {
        const loadMe = api<ExtensionMeResponse>("/api/extension/me")
            .then((response) => (me = response))
            .catch((err) => {
                if (!(err instanceof UnauthorizedError)) lastError = errorMessage(err)
            })
        await Promise.all([refreshAccounts(true), loadMe])
    }
    const link = await getLocal<Link>("link")
    if (link) {
        // Explicit popup use, including cached state requests, renews the interactive polling window.
        interactiveUntil = Date.now() + interactiveWindowMs
        void pollLoop()
    }
    const cache = await accounts()
    const providers = connectors.map((c) => ({provider: c.provider, name: c.name, loginUrl: c.loginUrl, account: cache[c.provider]?.account, error: cache[c.provider]?.error}))
    const error = lastError
    lastError = undefined
    return {linked: !!link, user: me?.user ?? link?.user, providers, tasks: link ? me?.tasks : undefined, running: activeCommands.size, serverUrl, redirectUri: chrome.identity.getRedirectURL(), error}
}

// Handle a popup message.
async function handleMessage(message: PopupMessage): Promise<PopupState> {
    if (message.type === "connect") {
        await connect().catch((err) => (lastError = errorMessage(err)))
        return popupState(true)
    }
    if (message.type === "disconnect") await disconnect()
    return popupState(message.type === "state" && !!message.refresh)
}

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse, (err) => sendResponse({error: errorMessage(err)}))
    return true
})

// Poll while the website is the active tab of the focused window, so site work never waits for the scheduled cadence.
chrome.tabs.onActivated.addListener(() => void checkSiteActive())
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url !== undefined || changeInfo.status === "complete")) void checkSiteActive()
})
chrome.windows.onFocusChanged.addListener(() => void checkSiteActive())

// Wake for the scheduled check when the system goes idle or locks, and keep the 30 minute cadence through the scheduling alarm.
chrome.idle.setDetectionInterval(idleThresholdSec)
chrome.idle.onStateChanged.addListener((state) => {
    if (state !== "active") void checkScheduledPoll()
})
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === scheduledPollAlarm) void checkScheduledPoll()
    else if (alarm.name === tabsCleanupAlarm) void cleanupTabs()
})
chrome.runtime.onStartup.addListener(() => void checkWake())
chrome.runtime.onInstalled.addListener(() => void checkWake())

// Recreate the scheduling alarm only when missing or on a wrong interval, anchored to the last check when one is stored; an aligned alarm is never shifted.
async function ensureScheduledPollAlarm(): Promise<void> {
    const alarm = await chrome.alarms.get(scheduledPollAlarm)
    if (alarm?.periodInMinutes === scheduledPollIntervalMinutes) return
    const last = (await getLocal<number>("lastScheduledPollAt")) ?? 0
    await chrome.alarms.create(scheduledPollAlarm, {when: last ? Math.max(Date.now(), last + extensionScheduledPollIntervalMs) : Date.now() + extensionScheduledPollIntervalMs, periodInMinutes: scheduledPollIntervalMinutes})
}

// Drop the alarm name used by older builds, then make sure the scheduling alarm exists.
void chrome.alarms.clear("playlistsyncer")
void ensureScheduledPollAlarm()
void checkWake()
