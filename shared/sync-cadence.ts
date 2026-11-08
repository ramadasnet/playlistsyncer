// Automatic sync interval helpers shared by server scheduling and public copy.

export const defaultSyncIntervalMinutes = 720

// Convert a sync interval in minutes to milliseconds.
export function syncIntervalMs(minutes: number) {
    return minutes * 60 * 1000
}

// Format a minute-based cadence for public and account copy.
export function formatSyncIntervalEvery(minutes: number, options?: {capitalize?: boolean}) {
    const amount = minutes % 60 === 0 ? minutes / 60 : minutes
    const unit = minutes % 60 === 0 ? (amount === 1 ? "hour" : "hours") : amount === 1 ? "minute" : "minutes"
    const phrase = `every ${amount} ${unit}`
    return options?.capitalize ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : phrase
}

// Short headline for hero callouts when the interval divides a day evenly.
export function formatSyncCadenceHeadline(minutes: number) {
    if (1440 % minutes === 0) {
        const timesPerDay = 1440 / minutes
        if (timesPerDay === 1) {
            return "Once a day"
        }
        if (timesPerDay === 2) {
            return "Twice a day"
        }
        return `${timesPerDay} times a day`
    }
    return formatSyncIntervalEvery(minutes, {capitalize: true})
}
