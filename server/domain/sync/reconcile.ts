import type {ProviderTrack} from "../providers"

export interface ReconciledTrack {
    key: string
    count: number
    reference: ProviderTrack
}

export interface ReconciliationResult {
    desired: ReconciledTrack[]
    conflicts: string[]
}

export function normalizeText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\([^)]*(remaster|live|version|edit)[^)]*\)/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
}

export function trackKey(track: Pick<ProviderTrack, "isrc" | "title" | "artists" | "durationMs">): string {
    if ("canonicalKey" in track && track.canonicalKey) {
        return track.canonicalKey as string
    }
    return `meta:${normalizeText(track.title)}:${normalizeText(track.artists[0] || "")}`
}

function counts(tracks: ProviderTrack[]): Map<string, {count: number; reference: ProviderTrack}> {
    const result = new Map<string, {count: number; reference: ProviderTrack}>()
    for (const track of tracks) {
        const key = trackKey(track)
        const existing = result.get(key)
        result.set(key, {count: (existing?.count || 0) + 1, reference: existing?.reference || track})
    }
    return result
}

export function commonTracks(source: ProviderTrack[], destination: ProviderTrack[]): ProviderTrack[] {
    const remaining = new Map([...counts(destination)].map(([key, value]) => [key, value.count]))
    return source.filter((track) => {
        const key = trackKey(track)
        const count = remaining.get(key) || 0
        if (!count) return false
        remaining.set(key, count - 1)
        return true
    })
}

export function reconcileOneWay(source: ProviderTrack[]): ReconciliationResult {
    return {
        desired: [...counts(source)].map(([key, value]) => ({
            key,
            count: value.count,
            reference: value.reference
        })),
        conflicts: []
    }
}

export function reconcileThreeWay(
    baseline: ProviderTrack[],
    source: ProviderTrack[],
    destination: ProviderTrack[]
): ReconciliationResult {
    const baselineCounts = counts(baseline)
    const sourceCounts = counts(source)
    const destinationCounts = counts(destination)
    const keys = new Set([...baselineCounts.keys(), ...sourceCounts.keys(), ...destinationCounts.keys()])
    const desired: ReconciledTrack[] = []
    const conflicts: string[] = []

    for (const key of keys) {
        const baselineCount = baselineCounts.get(key)?.count || 0
        const sourceCount = sourceCounts.get(key)?.count || 0
        const destinationCount = destinationCounts.get(key)?.count || 0
        const sourceChanged = sourceCount !== baselineCount
        const destinationChanged = destinationCount !== baselineCount
        let count = baselineCount

        if (sourceChanged && !destinationChanged) {
            count = sourceCount
        } else if (!sourceChanged && destinationChanged) {
            count = destinationCount
        } else if (sourceChanged && destinationChanged && sourceCount === destinationCount) {
            count = sourceCount
        } else if (sourceChanged && destinationChanged) {
            count = Math.max(sourceCount, destinationCount)
            conflicts.push(key)
        }

        const reference =
            sourceCounts.get(key)?.reference ||
            destinationCounts.get(key)?.reference ||
            baselineCounts.get(key)?.reference
        if (count > 0 && reference) {
            desired.push({key, count, reference})
        }
    }
    return {desired, conflicts}
}
