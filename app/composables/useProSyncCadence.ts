// Expose the configured PRO automatic sync interval for plan copy.
import {defaultProSyncIntervalHours, formatProSyncCadenceHeadline, formatProSyncIntervalEvery} from "~~/shared/sync-cadence"

// Read the public PRO sync interval and preformatted labels for UI copy.
export function useProSyncCadence() {
    const config = useRuntimeConfig()
    const hours = computed(() => {
        const value = Number(config.public.proSyncIntervalHours)
        return Number.isFinite(value) && value > 0 ? value : defaultProSyncIntervalHours
    })
    const everyLabel = computed(() => formatProSyncIntervalEvery(hours.value))
    const everyTitleLabel = computed(() => formatProSyncIntervalEvery(hours.value, {capitalize: true}))
    const headlineLabel = computed(() => formatProSyncCadenceHeadline(hours.value))

    return {hours, everyLabel, everyTitleLabel, headlineLabel}
}
