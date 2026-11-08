// Expose the configured automatic sync interval for public copy.
import {defaultSyncIntervalMinutes, formatSyncCadenceHeadline, formatSyncIntervalEvery} from "~~/shared/sync-cadence"

// Read the public sync interval and preformatted labels for UI copy.
export function useSyncCadence() {
    const config = useRuntimeConfig()
    const minutes = computed(() => {
        const value = Number(config.public.syncIntervalMinutes)
        return Number.isInteger(value) && value > 0 ? value : defaultSyncIntervalMinutes
    })
    const everyLabel = computed(() => formatSyncIntervalEvery(minutes.value))
    const everyTitleLabel = computed(() => formatSyncIntervalEvery(minutes.value, {capitalize: true}))
    const headlineLabel = computed(() => formatSyncCadenceHeadline(minutes.value))

    return {minutes, everyLabel, everyTitleLabel, headlineLabel}
}
