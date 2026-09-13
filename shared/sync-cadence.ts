// PRO automatic sync interval helpers shared by server scheduling and marketing copy.

export const defaultProSyncIntervalHours = 12

// Convert a PRO sync interval in hours to milliseconds.
export function proSyncIntervalMs(hours: number) {
    return hours * 60 * 60 * 1000
}

// Format "every N hour(s)" for plan and account copy.
export function formatProSyncIntervalEvery(hours: number, options?: {capitalize?: boolean}) {
    const unit = hours === 1 ? "hour" : "hours"
    const phrase = `every ${hours} ${unit}`
    return options?.capitalize ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : phrase
}

// Short headline for hero callouts when the interval divides a day evenly.
export function formatProSyncCadenceHeadline(hours: number) {
    if (24 % hours === 0) {
        const timesPerDay = 24 / hours
        if (timesPerDay === 1) {
            return "Once a day"
        }
        if (timesPerDay === 2) {
            return "Twice a day"
        }
        return `${timesPerDay} times a day`
    }
    return formatProSyncIntervalEvery(hours, {capitalize: true})
}
