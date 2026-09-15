// Normalize provider metadata and choose the safest track match.
import type {ProviderTrack} from "./types"

// Increment when matching semantics change so existing snapshots can be rebuilt.
export const trackMatchingVersion = 2

const bracketedTitleNoise = /\s*[([][^\])]*(?:official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|hd|hq)[^\])]*[\])]\s*$/i
const trailingTitleNoise = /\s*[-–—]\s*(?:(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er)|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|hd|hq)\s*$/i
const recordingQualifiers = ["live", "acoustic", "remix", "karaoke", "instrumental", "cover", "demo", "sped up", "slowed"]

function normalize(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
}

// Remove common release and video suffixes before provider searches.
export function searchableTitle(value: string): string {
    let title = value.trim()
    let previous = ""
    while (title !== previous) {
        previous = title
        title = title.replace(bracketedTitleNoise, "").replace(trailingTitleNoise, "").trim()
    }
    return title
}

function normalizedTitle(value: string): string {
    return normalize(searchableTitle(value))
}

function hasQualifierMismatch(source: string, candidate: string): boolean {
    const sourceTitle = normalize(source)
    const candidateTitle = normalize(candidate)
    return recordingQualifiers.some((qualifier) => sourceTitle.includes(qualifier) !== candidateTitle.includes(qualifier))
}

function words(value: string): Set<string> {
    return new Set(value.split(" ").filter(Boolean))
}

function wordSimilarity(left: string, right: string): number {
    if (left === right) return 1
    const leftWords = words(left)
    const rightWords = words(right)
    if (!leftWords.size || !rightWords.size) return 0
    let shared = 0
    for (const word of leftWords) {
        if (rightWords.has(word)) shared++
    }
    return (2 * shared) / (leftWords.size + rightWords.size)
}

function artistSimilarity(source: string, candidate: string): number {
    const left = normalize(source)
    const right = normalize(candidate)
    if (left.replaceAll(" ", "") === right.replaceAll(" ", "")) return 1
    if (left.startsWith(`${right} and the `) || right.startsWith(`${left} and the `)) return 0.95
    return wordSimilarity(left, right)
}

// Extract artist and title metadata from YouTube's display conventions.
export function youtubeMetadata(title: string, channelTitle?: string): Pick<ProviderTrack, "title" | "artists"> {
    const parts = title.split(/\s[-–—]\s/, 2)
    if (parts.length === 2) {
        return {artists: [parts[0]!.trim()], title: parts[1]!.trim()}
    }
    const artist = channelTitle
        ?.replace(/\s+-\s+Topic$/i, "")
        .replace(/\s*VEVO$/i, "")
        .replace(/\s+(?:Official|Official Channel)$/i, "")
        .trim()
    return {title, artists: artist ? [artist] : []}
}

// Select a candidate using ISRCs first and conservative metadata scoring second.
export function findBestTrackMatch(source: ProviderTrack, candidates: ProviderTrack[]): ProviderTrack | null {
    if (source.isrc) {
        const isrcMatch = candidates.find((candidate) => candidate.isrc === source.isrc)
        if (isrcMatch) return isrcMatch
    }
    if (!source.artists.length) return null

    const sourceTitle = normalizedTitle(source.title)
    let best: {track: ProviderTrack; score: number} | undefined
    for (const candidate of candidates) {
        if (hasQualifierMismatch(source.title, candidate.title)) continue
        const titleScore = wordSimilarity(sourceTitle, normalizedTitle(candidate.title))
        const artistScore = Math.max(0, ...source.artists.flatMap((sourceArtist) => candidate.artists.map((candidateArtist) => artistSimilarity(sourceArtist, candidateArtist))))
        if (titleScore < 0.8 || artistScore < 0.8) continue
        const score = titleScore * 0.65 + artistScore * 0.35
        if (!best || score > best.score) best = {track: candidate, score}
    }
    return best?.track || null
}

export interface SimilarTrackMatch {
    track: ProviderTrack
    score: number
}

// Score how close two durations are. Exact-ish lengths rank highest; gaps over 30s score 0.
export function durationSimilarity(sourceMs?: number, candidateMs?: number): number {
    if (!sourceMs || !candidateMs) return 0.5
    const delta = Math.abs(sourceMs - candidateMs)
    if (delta <= 2000) return 1
    if (delta >= 30000) return 0
    return 1 - (delta - 2000) / 28000
}

function similarTrackScore(source: ProviderTrack, candidate: ProviderTrack): number {
    if (source.isrc && candidate.isrc === source.isrc) return 1
    const titleScore = wordSimilarity(normalizedTitle(source.title), normalizedTitle(candidate.title))
    const artistScore = source.artists.length ? Math.max(0, ...source.artists.flatMap((sourceArtist) => candidate.artists.map((candidateArtist) => artistSimilarity(sourceArtist, candidateArtist)))) : 0.45
    const lengthScore = durationSimilarity(source.durationMs, candidate.durationMs)
    const qualifierPenalty = hasQualifierMismatch(source.title, candidate.title) ? 0.72 : 1
    return (titleScore * 0.5 + artistScore * 0.3 + lengthScore * 0.2) * qualifierPenalty
}

// Rank looser near-matches for manual selection after automatic matching failed.
export function rankSimilarTracks(source: ProviderTrack, candidates: ProviderTrack[], limit = 5): SimilarTrackMatch[] {
    const seen = new Set<string>()
    return candidates
        .map((track) => ({track, score: similarTrackScore(source, track)}))
        .filter((item) => {
            if (item.score < 0.4 || seen.has(item.track.trackId)) return false
            seen.add(item.track.trackId)
            return true
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
}

// Parse YouTube/TIDAL ISO-8601 durations such as PT3M12S into milliseconds.
export function parseIsoDurationMs(value?: string): number | undefined {
    if (!value) return undefined
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value.trim())
    if (!match) return undefined
    const hours = Number(match[1] || 0)
    const minutes = Number(match[2] || 0)
    const seconds = Number(match[3] || 0)
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
}
