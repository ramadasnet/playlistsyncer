// YouTube replaces a deleted or private video's title with one of these placeholders.
const unavailableTitles = new Set(["deleted video", "private video"])

// True when a stored track is a YouTube video that can no longer be played or matched.
export function isUnavailableSyncTrack(track: {title?: string}) {
    const title = (track.title || "")
        .trim()
        .toLowerCase()
        .replace(/^\[+|\]+$/g, "")
        .trim()
    return unavailableTitles.has(title)
}

// Split a run's skipped total into tracks that still need a match and videos YouTube has hidden.
export function unmatchedCategoryCounts(skipped: number, tracks: {title?: string}[]) {
    const unavailable = tracks.filter((track) => isUnavailableSyncTrack(track)).length
    const storedUnmatched = tracks.length - unavailable
    const unlabeled = Math.max(0, skipped - tracks.length)
    return {unmatched: storedUnmatched + unlabeled, unavailable}
}
