// Enforce the free-tier interval between manually started syncs.
import type {AccountTier} from "~~/shared/types/domain"

export const freeManualSyncCooldownMs = 24 * 60 * 60 * 1000

// Return the next allowed manual run time, if a cooldown is active.
export function manualSyncAvailableAt(tier: AccountTier, lastSuccessAt?: Date, now: Date = new Date()): Date | undefined {
    if (tier === "pro" || !lastSuccessAt) return undefined
    const availableAt = new Date(lastSuccessAt.getTime() + freeManualSyncCooldownMs)
    return availableAt > now ? availableAt : undefined
}
