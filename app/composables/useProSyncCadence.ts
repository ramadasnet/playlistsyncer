// Expose the configured PRO automatic sync interval for plan copy.
import {defaultProSyncIntervalMinutes, formatProSyncCadenceHeadline, formatProSyncIntervalEvery} from "~~/shared/sync-cadence"

// Read the public PRO sync interval and preformatted labels for UI copy.
export function useProSyncCadence() {
    const config = useRuntimeConfig()
    const minutes = computed(() => {
        const value = Number(config.public.proSyncIntervalMinutes)
        return Number.isInteger(value) && value > 0 ? value : defaultProSyncIntervalMinutes
    })
    const everyLabel = computed(() => formatProSyncIntervalEvery(minutes.value))
    const everyTitleLabel = computed(() => formatProSyncIntervalEvery(minutes.value, {capitalize: true}))
    const headlineLabel = computed(() => formatProSyncCadenceHeadline(minutes.value))

    return {minutes, everyLabel, everyTitleLabel, headlineLabel}
}
