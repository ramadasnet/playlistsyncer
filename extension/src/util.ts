// Small helpers shared by the background script and the providers.
import type {ExtensionTrack} from "../../shared/types/extension"

// Extra info for webRequest header listeners; Chrome needs "extraHeaders" to see all request headers.
export const requestHeadersSpec = (PLS_BROWSER === "chrome" ? ["requestHeaders", "extraHeaders"] : ["requestHeaders"]) as chrome.webRequest.OnBeforeSendHeadersOptions[]

// Read one value from the local extension storage.
export async function getLocal<T>(key: string): Promise<T | undefined> {
    return (await chrome.storage.local.get(key))[key] as T | undefined
}

// Write values to the local extension storage.
export async function setLocal(values: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(values)
}

// Wait for the given number of milliseconds.
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// Poll until the check returns a value, or return undefined after the timeout.
export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
        const value = await check()
        if (value) return value
        await sleep(500)
    }
    return undefined
}

// Map items with limited concurrency, keeping the order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await fn(items[index]!)
        }
    }
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
    return results
}

// Message of an unknown error.
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

// Parse JSON, returning undefined when invalid.
export function parseJson(text: string): any {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

// Search text for a track: the title without featuring / remaster noise, plus the first artist.
export function searchText(track: ExtensionTrack): string {
    const title = track.title
        .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "")
        .replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mono|stereo)\b.*$/i, "")
        .trim()
    return [title, track.artists[0]].filter(Boolean).join(" ")
}
