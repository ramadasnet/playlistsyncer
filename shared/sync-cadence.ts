// PRO automatic sync interval helpers shared by server scheduling and marketing copy.

export const defaultProSyncIntervalMinutes = 720

// Convert a PRO sync interval in minutes to milliseconds.
export function proSyncIntervalMs(minutes: number) {
    return minutes * 60 * 1000
}

// Format a minute-based cadence for plan and account copy.
export function formatProSyncIntervalEvery(minutes: number, options?: {capitalize?: boolean}) {
    const amount = minutes % 60 === 0 ? minutes / 60 : minutes
    const unit = minutes % 60 === 0 ? (amount === 1 ? "hour" : "hours") : amount === 1 ? "minute" : "minutes"
    const phrase = `every ${amount} ${unit}`
    return options?.capitalize ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : phrase
}

// Short headline for hero callouts when the interval divides a day evenly.
export function formatProSyncCadenceHeadline(minutes: number) {
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
    return formatProSyncIntervalEvery(minutes, {capitalize: true})
}
