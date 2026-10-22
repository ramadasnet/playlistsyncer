// Reconciliation helpers compare provider playlists while preserving duplicate tracks.
import type {ProviderTrack} from "../providers"

// A normalized track occurrence and its number of desired copies.
export interface ReconciledTrack {
    key: string
    count: number
    reference: ProviderTrack
}

// The desired playlist state and any concurrent-edit conflicts.
export interface ReconciliationResult {
    desired: ReconciledTrack[]
    conflicts: string[]
}

// Normalize searchable track text so equivalent titles share a key.
export function normalizeText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\([^)]*(remaster|live|version|edit)[^)]*\)/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
}

// Country, registrant, year, and designation. Anything else is not an identity.
const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

function metadataKey(track: Pick<ProviderTrack, "title" | "artists">): string {
    return `meta:${normalizeText(track.title)}:${normalizeText(track.artists[0] || "")}`
}

// Return a 12-character ISRC, or nothing when the provider value is missing or malformed.
export function recordingIsrc(isrc?: string): string | undefined {
    const normalized = isrc?.replace(/[^a-z0-9]/gi, "").toUpperCase()
    return normalized && isrcPattern.test(normalized) ? normalized : undefined
}

// Prefer a saved canonical key, then metadata. An ISRC becomes the key only through shareRecordingKeys.
export function trackKey(track: Pick<ProviderTrack, "isrc" | "title" | "artists" | "durationMs">): string {
    if ("canonicalKey" in track && track.canonicalKey) {
        return track.canonicalKey as string
    }
    return metadataKey(track)
}

// Give both sides an ISRC key when they share a valid ISRC. A one-sided ISRC keeps the metadata key.
export function shareRecordingKeys(groups: ProviderTrack[][]): ProviderTrack[][] {
    const isrcSides = new Map<string, number>()
    for (const group of groups) {
        const seen = new Set<string>()
        for (const track of group) {
            const isrc = recordingIsrc(track.isrc)
            if (!isrc || seen.has(isrc)) continue
            seen.add(isrc)
            isrcSides.set(isrc, (isrcSides.get(isrc) || 0) + 1)
        }
    }
    const sharedIsrcs = new Set([...isrcSides].filter(([, count]) => count > 1).map(([isrc]) => isrc))
    const blocked = new Set<string>()
    for (const group of groups) {
        for (const track of group) {
            const isrc = recordingIsrc(track.isrc)
            if (!isrc || !sharedIsrcs.has(isrc)) continue
            if (track.canonicalKey && track.canonicalKey !== `isrc:${isrc}`) blocked.add(isrc)
        }
    }
    const canonicalUsers = new Map<string, number>()
    for (const group of groups) {
        const seen = new Set<string>()
        for (const track of group) {
            if (!track.canonicalKey || seen.has(track.canonicalKey)) continue
            seen.add(track.canonicalKey)
            canonicalUsers.set(track.canonicalKey, (canonicalUsers.get(track.canonicalKey) || 0) + 1)
        }
    }
    const groupKeys = groups.map((group) => new Set(group.map((track) => trackKey(track))))
    return groups.map((group, groupIndex) =>
        group.map((track) => {
            const isrc = recordingIsrc(track.isrc)
            const isrcKey = isrc ? `isrc:${isrc}` : undefined
            if (isrc && isrcKey && sharedIsrcs.has(isrc) && !blocked.has(isrc) && (!track.canonicalKey || track.canonicalKey === isrcKey)) {
                return track.canonicalKey === isrcKey ? track : {...track, canonicalKey: isrcKey}
            }
            // A saved ISRC key that the other side does not use must not hide an equal metadata key there.
            // Without one, the other side removed the track, and the saved key must still match the baseline.
            if (track.canonicalKey?.startsWith("isrc:") && (canonicalUsers.get(track.canonicalKey) || 0) < 2) {
                const key = metadataKey(track)
                if (groupKeys.some((keys, index) => index !== groupIndex && keys.has(key))) {
                    return {...track, canonicalKey: key}
                }
            }
            return track
        })
    )
}

// Count track occurrences by their reconciliation key.
function counts(tracks: ProviderTrack[]): Map<string, {count: number; reference: ProviderTrack}> {
    const result = new Map<string, {count: number; reference: ProviderTrack}>()
    for (const track of tracks) {
        const key = trackKey(track)
        const existing = result.get(key)
        result.set(key, {count: (existing?.count || 0) + 1, reference: existing?.reference || track})
    }
    return result
}

// Return source occurrences that can be matched one-for-one in the destination.
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

// Build a desired state that mirrors every source occurrence.
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

// Merge source and destination changes against their shared baseline.
export function reconcileThreeWay(baseline: ProviderTrack[], source: ProviderTrack[], destination: ProviderTrack[]): ReconciliationResult {
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

        const reference = sourceCounts.get(key)?.reference || destinationCounts.get(key)?.reference || baselineCounts.get(key)?.reference
        if (count > 0 && reference) {
            desired.push({key, count, reference})
        }
    }
    return {desired, conflicts}
}
