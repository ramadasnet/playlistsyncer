// Integration-style tests for the extension background scheduler: the real background entrypoint and tab helpers run against a
// mocked chrome API surface, a fake clock and a canned fetch, with the provider connectors stubbed by extension-providers-stub.ts.
// Every test builds a fresh bundle, so "reloading" the module simulates a service-worker restart with storage kept.
import {afterEach, describe, expect, test} from "bun:test"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const serverOrigin = "https://test.playlistsyncer.com"
const backgroundEntry = process.env.PLS_EXTENSION_BACKGROUND ?? resolve(import.meta.dir, "../extension/src/background.ts")
const stubProviders = resolve(import.meta.dir, "extension-providers-stub.ts")
const outdir = mkdtempSync(join(tmpdir(), "pls-ext-scheduler-"))

// Real globals captured before any test installs fakes, so they can be restored and used to drain microtasks.
const real = {
    dateNow: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    fetch: globalThis.fetch,
    abortTimeout: AbortSignal.timeout,
    chrome: (globalThis as Record<string, unknown>).chrome
}

interface FakeTimer {
    id: number
    at: number
    interval: number
    fn: () => void
}

interface AlarmInfo {
    name: string
    scheduledTime: number
    periodInMinutes?: number
}

interface FakeTab {
    id: number
    windowId: number
    url: string
    active: boolean
    status: string
    discarded: boolean
}

interface Env {
    local: Map<string, unknown>
    session: Map<string, unknown>
    tabs: Map<number, FakeTab>
    alarms: Map<string, AlarmInfo>
    listeners: Record<string, ((...args: any[]) => void)[]>
    fetches: {url: string; body: any}[]
    pollQueue: Record<string, unknown>[]
    pollDelayMs: number
    scriptDelayMs?: number
    idleState: string
    detectionInterval?: number
    focusedWindowId: number
    browserFocused: boolean
    nextTabId: number
    createdTabs: FakeTab[]
}

let now = 0
let timers: FakeTimer[] = []
let nextTimerId = 1
let buildCount = 0
let env: Env

function createEnv(): Env {
    return {
        local: new Map(),
        session: new Map(),
        tabs: new Map(),
        alarms: new Map(),
        listeners: {message: [], startup: [], installed: [], alarm: [], idle: [], tabActivated: [], tabUpdated: [], focus: []},
        fetches: [],
        pollQueue: [],
        pollDelayMs: 500,
        idleState: "active",
        focusedWindowId: 1,
        browserFocused: true,
        nextTabId: 1,
        createdTabs: []
    }
}

// Match the chrome.tabs.query URL match patterns used by the extension, e.g. "https://*.spotify.com/*".
function matchUrl(url: string, patterns: string[]): boolean {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return false
    }
    return patterns.some((pattern) => {
        const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern)
        if (!m || (m[1] !== "*" && parsed.protocol !== `${m[1]}:`)) return false
        const host = m[2]!
        if (host.startsWith("*.")) {
            const suffix = host.slice(2)
            if (parsed.hostname !== suffix && !parsed.hostname.endsWith(`.${suffix}`)) return false
        } else if (host !== "*" && parsed.hostname !== host) return false
        const rx = new RegExp(`^${m[3]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
        return rx.test(parsed.pathname + parsed.search)
    })
}

function createChrome(e: Env): Record<string, unknown> {
    const storage = (map: Map<string, unknown>) => ({
        get: async (key?: string | string[] | Record<string, unknown>) => {
            if (typeof key === "string") return {[key]: map.get(key)}
            if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, map.get(k)]))
            if (key == null) return Object.fromEntries(map)
            return Object.fromEntries(Object.keys(key).map((k) => [k, map.get(k) ?? key[k]]))
        },
        set: async (values: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(values)) map.set(k, v)
        },
        remove: async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k)
        }
    })
    const on = (name: string) => ({addListener: (fn: (...args: any[]) => void) => e.listeners[name]!.push(fn)})
    return {
        storage: {local: storage(e.local), session: storage(e.session)},
        runtime: {
            getManifest: () => ({version: "1.0.0", host_permissions: [`${serverOrigin}/*`]}),
            getPlatformInfo: async () => ({os: "test"}),
            onMessage: on("message"),
            onStartup: on("startup"),
            onInstalled: on("installed")
        },
        alarms: {
            get: async (name: string) => e.alarms.get(name),
            create: async (name: string, info: {when?: number; delayInMinutes?: number; periodInMinutes?: number}) => {
                e.alarms.set(name, {name, scheduledTime: info.when ?? now + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000, periodInMinutes: info.periodInMinutes})
            },
            clear: async (name: string) => e.alarms.delete(name),
            onAlarm: on("alarm")
        },
        idle: {
            setDetectionInterval: (seconds: number) => (e.detectionInterval = seconds),
            queryState: async () => e.idleState,
            onStateChanged: on("idle")
        },
        tabs: {
            query: async (q: {active?: boolean; lastFocusedWindow?: boolean; url?: string[]; discarded?: boolean}) =>
                [...e.tabs.values()].filter(
                    (t) =>
                        (q.active === undefined || t.active === q.active) && (q.lastFocusedWindow === undefined || t.windowId === e.focusedWindowId) && (q.discarded === undefined || t.discarded === q.discarded) && (!q.url || matchUrl(t.url, q.url))
                ),
            get: async (id: number) => {
                const tab = e.tabs.get(id)
                if (!tab) throw new Error(`No tab ${id}`)
                return tab
            },
            create: async (props: {url?: string; active?: boolean}) => {
                const tab: FakeTab = {id: e.nextTabId++, windowId: e.focusedWindowId, url: props.url ?? "about:blank", active: false, status: "complete", discarded: false}
                e.tabs.set(tab.id, tab)
                e.createdTabs.push(tab)
                if (props.active) await activateTab(e, tab.id)
                return tab
            },
            remove: async (id: number) => {
                e.tabs.delete(id)
            },
            reload: async (id: number) => {
                const tab = e.tabs.get(id)
                if (tab) tab.status = "complete"
            },
            onActivated: on("tabActivated"),
            onUpdated: on("tabUpdated")
        },
        windows: {
            getLastFocused: async () => ({id: Math.max(e.focusedWindowId, 1), focused: e.browserFocused}),
            onFocusChanged: on("focus")
        },
        scripting: {
            executeScript: async (details: {func: (...args: any[]) => unknown; args?: unknown[]}) => {
                if (e.scriptDelayMs) await new Promise((resolve) => fakeTimer(resolve, e.scriptDelayMs))
                return [{result: await details.func(...(details.args ?? []))}]
            }
        },
        identity: {getRedirectURL: () => "https://ext.chromiumapp.org/", launchWebAuthFlow: async () => Promise.reject(new Error("not linked in tests"))},
        permissions: {contains: async () => true, request: async () => true}
    }
}

// Drain pending microtasks through real macrotask yields.
async function flush(rounds = 25): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => real.setTimeout(resolve, 0))
}

function fire(e: Env, name: string, ...args: any[]): void {
    for (const fn of e.listeners[name]!) fn(...args)
}

// Advance the fake clock, firing due timers and alarms in order. Pending microtask work runs first so it can register timers at the current time.
async function advance(ms: number, e = env): Promise<void> {
    const target = now + ms
    await flush()
    for (;;) {
        const timer = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        const alarm = [...e.alarms.values()].filter((a) => a.scheduledTime <= target).sort((a, b) => a.scheduledTime - b.scheduledTime)[0]
        const at = Math.min(timer?.at ?? Infinity, alarm?.scheduledTime ?? Infinity)
        if (at === Infinity) break
        now = at
        if (timer && timer.at <= now) {
            if (timer.interval) timer.at = now + timer.interval
            else timers.splice(timers.indexOf(timer), 1)
            timer.fn()
        }
        if (alarm && alarm.scheduledTime <= now) {
            if (alarm.periodInMinutes) alarm.scheduledTime = now + alarm.periodInMinutes * 60_000
            else e.alarms.delete(alarm.name)
            fire(e, "alarm", alarm)
        }
        await flush(8)
    }
    now = target
    await flush()
}

function fakeTimer(fn: () => void, ms: number, interval = 0): number {
    const id = nextTimerId++
    timers.push({id, at: now + ms, interval, fn})
    return id
}

function installFakes(e: Env): void {
    Date.now = () => now
    globalThis.setTimeout = ((fn: (...args: any[]) => void, ms = 0, ...args: any[]) => fakeTimer(() => fn(...args), ms)) as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => (timers = timers.filter((t) => t.id !== id))) as typeof clearTimeout
    globalThis.setInterval = ((fn: (...args: any[]) => void, ms = 0, ...args: any[]) => fakeTimer(() => fn(...args), ms, ms)) as typeof setInterval
    globalThis.clearInterval = globalThis.clearTimeout
    AbortSignal.timeout = (() => new AbortController().signal) as typeof AbortSignal.timeout
    globalThis.fetch = (async (input: unknown, init?: {body?: unknown}) => {
        const url = String(input)
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        e.fetches.push({url, body})
        if (url.endsWith("/api/extension/poll")) {
            await new Promise((resolve) => fakeTimer(resolve, e.pollDelayMs))
            const response = e.pollQueue.length ? e.pollQueue.shift()! : {commands: [], busy: false}
            return new Response(JSON.stringify(response), {status: 200})
        }
        return new Response("{}", {status: 200})
    }) as typeof fetch
    ;(globalThis as Record<string, unknown>).chrome = createChrome(e)
}

afterEach(() => {
    Date.now = real.dateNow
    globalThis.setTimeout = real.setTimeout
    globalThis.clearTimeout = real.clearTimeout
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
    globalThis.fetch = real.fetch
    AbortSignal.timeout = real.abortTimeout
    ;(globalThis as Record<string, unknown>).chrome = real.chrome
})

// ---- env helpers ----

function setup(): Env {
    now = 1_000_000_000
    timers = []
    nextTimerId = 1
    env = createEnv()
    env.local.set("link", {token: "token-1", user: {name: "Tester"}})
    installFakes(env)
    return env
}

async function loadBackground(): Promise<void> {
    // Listeners belong to the previous worker realm, so a reload clears them while storage, tabs and alarms persist.
    for (const key of Object.keys(env.listeners)) env.listeners[key] = []
    const build = await Bun.build({
        entrypoints: [backgroundEntry],
        target: "browser",
        format: "esm",
        define: {PLS_EXTENSION_SERVER_URL: JSON.stringify(serverOrigin), PLS_BROWSER: JSON.stringify("chrome")},
        plugins: [{name: "stub-providers", setup: (b) => b.onResolve({filter: /^\.\/providers$/}, () => ({path: stubProviders}))}]
    })
    if (!build.success) throw new AggregateError(build.logs, "background build failed")
    const file = join(outdir, `background-${++buildCount}.js`)
    writeFileSync(file, await build.outputs[0]!.text())
    await import(file)
    await flush()
}

const polls = (e = env) => e.fetches.filter((f) => f.url.endsWith("/api/extension/poll"))
const posts = (path: string, e = env) => e.fetches.filter((f) => f.url.endsWith(path))

function addTab(e: Env, url: string, {active = false, windowId = e.focusedWindowId} = {}): FakeTab {
    const tab: FakeTab = {id: e.nextTabId++, windowId, url, active: false, status: "complete", discarded: false}
    e.tabs.set(tab.id, tab)
    if (active) {
        for (const t of e.tabs.values()) if (t.windowId === windowId) t.active = t.id === tab.id
    }
    return tab
}

async function activateTab(e: Env, tabId: number): Promise<void> {
    const target = e.tabs.get(tabId)!
    for (const t of e.tabs.values()) if (t.windowId === target.windowId) t.active = t.id === tabId
    fire(e, "tabActivated", {tabId, windowId: target.windowId})
    await flush()
}

// Move browser focus to a window, or out of the browser entirely with WINDOW_ID_NONE (-1).
async function focusWindow(e: Env, windowId: number): Promise<void> {
    e.focusedWindowId = windowId
    e.browserFocused = windowId >= 0
    fire(e, "focus", windowId)
    await flush()
}

async function setIdle(e: Env, state: "active" | "idle" | "locked"): Promise<void> {
    e.idleState = state
    fire(e, "idle", state)
    await flush()
}

function sendMessage(e: Env, message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
        for (const fn of e.listeners.message) fn(message, {}, resolve)
    })
}

describe("extension scheduler", () => {
    test("an active system never reaches the network on load, startup or the scheduling alarm", async () => {
        const e = setup()
        e.idleState = "active"
        await loadBackground()
        fire(e, "startup")
        fire(e, "installed")
        await advance(31 * 60_000)
        expect(polls().length).toBe(0)
        expect(e.fetches.length).toBe(0)
        expect(e.createdTabs.length).toBe(0)
        expect(e.detectionInterval).toBe(60)
        expect(e.alarms.get("playlistsyncer-scheduled")?.periodInMinutes).toBe(30)
    })

    test("an idle due check polls once with runScheduled, then sleeps until the next 30 minutes, even across worker reloads", async () => {
        const e = setup()
        e.idleState = "idle"
        await loadBackground()
        await advance(10_000)
        expect(polls().length).toBe(1)
        expect(polls()[0]!.body.runScheduled).toBe(true)
        const scheduledAt = e.alarms.get("playlistsyncer-scheduled")!.scheduledTime

        // No wake path before the cadence may produce another automatic request.
        await setIdle(e, "active")
        await setIdle(e, "locked")
        fire(e, "startup")
        fire(e, "installed")
        await loadBackground() // simulated service-worker reload; storage keeps the cadence
        expect(e.alarms.get("playlistsyncer-scheduled")!.scheduledTime).toBe(scheduledAt)
        await advance(10 * 60_000)
        expect(polls().length).toBe(1)

        // Once 30 minutes pass while the system is idle, the next wake runs one more check.
        await advance(21 * 60_000)
        await setIdle(e, "idle")
        await advance(10_000)
        expect(polls().length).toBe(2)
        expect(polls()[1]!.body.runScheduled).toBe(true)
        await advance(5_000)
        expect(polls().length).toBe(2)
    })

    test("busy responses and commands keep polling until the server reports idle and results are posted", async () => {
        const e = setup()
        e.idleState = "idle"
        e.pollQueue = [
            {commands: [], busy: true},
            {commands: [{id: "cmd-1", provider: "spotify", accountId: "acc-1", method: "listPlaylists", args: {}}], busy: true},
            {commands: [], busy: false}
        ]
        await loadBackground()
        await advance(30_000)
        expect(polls()[0]!.body.runScheduled).toBe(true)
        expect(polls()[1]!.body.runScheduled).toBe(false)
        const results = posts("/api/extension/results")
        expect(results.length).toBe(1)
        expect(results[0]!.body.results[0]).toMatchObject({id: "cmd-1", ok: true})
        const count = polls().length
        await advance(60_000)
        expect(polls().length).toBe(count)
    })

    test("popup and foreground site use poll while the system is active; background site tabs do not", async () => {
        const e = setup()
        e.idleState = "active"
        await loadBackground()
        fire(e, "startup")
        await flush()
        expect(polls().length).toBe(0)

        // A website tab that is not active in the focused window does not count as interaction.
        addTab(e, `${serverOrigin}/tasks`, {active: true, windowId: 2})
        await activateTab(e, e.nextTabId - 1)
        await advance(5_000)
        expect(polls().length).toBe(0)

        // Popup messages renew the interactive window and never set runScheduled while the system is active.
        await sendMessage(e, {type: "state"})
        await advance(5_000)
        expect(polls().length).toBeGreaterThan(0)
        expect(polls().every((p) => p.body.runScheduled === false)).toBe(true)
        await sendMessage(e, {type: "state"})

        // Once the popup window lapses with nothing else interactive, the loop sleeps.
        await advance(70_000)
        const lapsed = polls().length
        await advance(30_000)
        expect(polls().length).toBe(lapsed)

        // Focusing the window whose active tab is the website keeps polling live again.
        await focusWindow(e, 2)
        await advance(5_000)
        expect(polls().length).toBeGreaterThan(lapsed)
        expect(
            polls()
                .slice(lapsed)
                .every((p) => p.body.runScheduled === false)
        ).toBe(true)

        // An unfocused browser (user switched to another app) ends interactive polling even with the site tab still active.
        await focusWindow(e, -1)
        await advance(30_000)
        const stopped = polls().length
        await advance(30_000)
        expect(polls().length).toBe(stopped)
    })

    test("the scheduling alarm anchors to the actual check, so the next check is 30 minutes after it", async () => {
        const e = setup()
        e.idleState = "active"
        await loadBackground()
        await advance(5 * 60_000)
        await setIdle(e, "idle")
        await advance(10_000)
        expect(polls().length).toBe(1)
        const firstCheckedAt = e.local.get("lastScheduledPollAt") as number
        const aligned = e.alarms.get("playlistsyncer-scheduled")!.scheduledTime
        expect(aligned).toBe(firstCheckedAt + 30 * 60_000)

        // A worker reload keeps the aligned alarm instead of restarting the cadence.
        await loadBackground()
        expect(e.alarms.get("playlistsyncer-scheduled")!.scheduledTime).toBe(aligned)

        // The next check happens 30 minutes after the first poll, not on a worker-start schedule.
        await advance(30 * 60_000)
        expect(polls().length).toBe(2)
        expect(polls()[1]!.body.runScheduled).toBe(true)
    })

    test("a user resuming during detection stops the scheduled request but not the next idle check", async () => {
        const e = setup()
        e.idleState = "idle"
        e.scriptDelayMs = 10_000
        await loadBackground()
        await advance(5_000)
        await setIdle(e, "active")
        await advance(30_000)
        expect(polls().length).toBe(0)
        expect(e.local.has("lastScheduledPollAt")).toBe(false)

        // A later idle wakeup still gets its full scheduled check.
        await setIdle(e, "idle")
        await advance(15_000)
        expect(polls().length).toBe(1)
        expect(polls()[0]!.body.runScheduled).toBe(true)
    })

    test("extension-owned tabs close two minutes after use, active or user-taken tabs are kept", async () => {
        const e = setup()
        e.idleState = "idle"
        await loadBackground()
        await advance(10_000)
        const owned = e.createdTabs[0]!
        expect(owned).toBeDefined()
        expect(e.alarms.get("playlistsyncer-tabs")).toBeDefined()
        await advance(3 * 60_000)
        expect(e.tabs.has(owned.id)).toBe(false)

        // A tab the user activated stays open and is forgotten by the cleanup.
        const refreshed = sendMessage(e, {type: "state", refresh: true})
        await advance(10_000)
        await refreshed
        const second = e.createdTabs.find((t) => t.id !== owned.id)!
        expect(second).toBeDefined()
        await activateTab(e, second.id)
        await advance(3 * 60_000)
        expect(e.tabs.has(second.id)).toBe(true)
    })

    test("cleanup postpones while a command is in flight, then still closes the stale tab", async () => {
        const e = setup()
        e.idleState = "idle"
        e.scriptDelayMs = 8_000
        // A tab the extension owns, already idle for a minute.
        const stale = addTab(e, "https://example.com/old")
        e.session.set("ownedTabs", {[stale.id]: now - 60_000})
        e.pollQueue = [{commands: [{id: "cmd-x", provider: "spotify", accountId: "acc-1", method: "listPlaylists", args: {}}], busy: true}]
        await loadBackground()
        await advance(11_000) // detection ran, the command is now in flight

        // A cleanup fire during the command is postponed instead of closing anything.
        fire(e, "alarm", {name: "playlistsyncer-tabs", scheduledTime: now})
        await flush()
        expect(e.alarms.get("playlistsyncer-tabs")!.scheduledTime).toBe(now + 120_000)
        expect(e.tabs.has(stale.id)).toBe(true)

        // Once the command finishes and the alarm fires again, the stale tab is closed.
        await advance(130_000)
        expect(posts("/api/extension/results").length).toBe(1)
        expect(e.tabs.has(stale.id)).toBe(false)
    })

    test("unlink stops polling and clears the link-bound scheduling state", async () => {
        const e = setup()
        e.idleState = "active"
        await loadBackground()
        await sendMessage(e, {type: "state"})
        await advance(10_000)
        expect(polls().length).toBeGreaterThan(0)
        await sendMessage(e, {type: "disconnect"})
        await flush()
        expect(e.local.has("link")).toBe(false)
        expect(e.local.has("lastScheduledPollAt")).toBe(false)
        const count = polls().length
        await setIdle(e, "idle")
        await advance(61 * 60_000)
        expect(polls().length).toBe(count)
    })
})
