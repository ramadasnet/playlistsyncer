import type {AccountTier} from "~~/shared/types/domain"

export const freeManualSyncCooldownMs = 24 * 60 * 60 * 1000

export function manualSyncAvailableAt(
    tier: AccountTier,
    lastSuccessAt?: Date,
    now: Date = new Date()
): Date | undefined {
    if (tier === "pro" || !lastSuccessAt) return undefined
    const availableAt = new Date(lastSuccessAt.getTime() + freeManualSyncCooldownMs)
    return availableAt > now ? availableAt : undefined
}
