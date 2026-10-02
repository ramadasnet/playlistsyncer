// Format a track length as m:ss, or h:mm:ss once it reaches an hour.
export function formatDuration(ms?: number) {
    if (!ms) return ""
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const seconds = totalSeconds % 60
    const hours = Math.floor(totalSeconds / 3600)
    if (hours > 0) {
        const minutes = Math.floor(totalSeconds / 60) % 60
        return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    }
    const minutes = Math.floor(totalSeconds / 60)
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
}
