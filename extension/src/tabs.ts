// Provider tabs: find or open a tab on the provider web app and run code inside it.
import {ProviderError} from "./providers/types"
import {sleep, waitFor} from "./util"

const idleCloseMs = 2 * 60_000
const ownedKey = "ownedTabs"
// One-shot alarm that closes owned tabs once they go idle, independent of the poll schedule.
export const tabsCleanupAlarm = "playlistsyncer-tabs"
const opening = new Map<string, Promise<number>>()
let owned: Record<string, number> | undefined

// Tabs opened by the extension, keyed by tab ID, with their last use time.
async function ownedTabs(): Promise<Record<string, number>> {
    owned ??= ((await chrome.storage.session.get(ownedKey))[ownedKey] as Record<string, number> | undefined) ?? {}
    return owned
}

// Persist the tabs opened by the extension, and point the cleanup alarm at the earliest idle time or clear it when none remain.
async function saveOwned(): Promise<void> {
    await chrome.storage.session.set({[ownedKey]: owned ?? {}})
    const times = Object.values(owned ?? {})
    if (times.length) await chrome.alarms.create(tabsCleanupAlarm, {when: Math.min(...times) + idleCloseMs})
    else await chrome.alarms.clear(tabsCleanupAlarm)
}

// Mark a tab opened by the extension as used now, so it is not closed while commands run.
async function touchTab(tabId: number): Promise<void> {
    const tabs = await ownedTabs()
    if (!tabs[tabId]) return
    tabs[tabId] = Date.now()
    await saveOwned()
}

// Check whether a provider tab is open.
export async function hasProviderTab(patterns: string[]): Promise<boolean> {
    return (await chrome.tabs.query({url: patterns, discarded: false})).length > 0
}

// Find a loaded provider tab or open an inactive one. With fresh, reload a tab opened by the extension or open a new one, never reloading the user's tabs.
export function openProviderTab(url: string, patterns: string[], fresh = false): Promise<number> {
    const next = (opening.get(url) ?? Promise.resolve(0)).catch(() => 0).then(() => findOrOpenTab(url, patterns, fresh))
    opening.set(url, next)
    return next
}

// Implementation of openProviderTab, serialized per URL.
async function findOrOpenTab(url: string, patterns: string[], fresh: boolean): Promise<number> {
    const mine = await ownedTabs()
    const tabs = await chrome.tabs.query({url: patterns, discarded: false})
    let tab = fresh ? tabs.find((t) => t.id && mine[t.id]) : (tabs.find((t) => t.status === "complete") ?? tabs[0])
    if (tab?.id && fresh) {
        await chrome.tabs.reload(tab.id)
        await sleep(1000)
    }
    if (!tab?.id) {
        tab = await chrome.tabs.create({url, active: false})
        mine[tab.id!] = Date.now()
        await saveOwned()
        await sleep(1000)
    }
    const tabId = tab.id!
    const loaded = await waitFor(async () => (await chrome.tabs.get(tabId)).status === "complete", 30_000)
    if (!loaded) throw new ProviderError(`Timed out loading ${url}`)
    await touchTab(tabId)
    return tabId
}

// Close tabs opened by the extension that were idle for 2 minutes. Tabs the user switched to are kept and forgotten.
export async function closeIdleTabs(): Promise<void> {
    const tabs = await ownedTabs()
    for (const [id, usedAt] of Object.entries(tabs)) {
        const tab = await chrome.tabs.get(Number(id)).catch(() => undefined)
        if (tab && !tab.active && Date.now() - usedAt < idleCloseMs) continue
        if (tab && !tab.active) await chrome.tabs.remove(tab.id!).catch(() => undefined)
        delete tabs[id]
    }
    await saveOwned()
}

// Run a self-contained function inside the page of a tab and return its JSON-serializable result.
export async function runInTab<A extends unknown[], R>(tabId: number, func: (...args: A) => R | Promise<R>, args: A): Promise<R> {
    await touchTab(tabId)
    const [injection] = await chrome.scripting.executeScript({target: {tabId}, world: "MAIN", func, args})
    await touchTab(tabId)
    return injection?.result as R
}

export interface PageFetchInit {
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: RequestCredentials
}

// Fetch from inside a provider page (injected, must stay self-contained) and return the status and body text.
export async function pageFetch(url: string, init: PageFetchInit): Promise<{status: number; text: string}> {
    try {
        const res = await fetch(url, init)
        return {status: res.status, text: await res.text()}
    } catch (err) {
        return {status: 0, text: String(err)}
    }
}
