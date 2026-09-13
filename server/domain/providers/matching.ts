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
