// Keep full-sync identity fields compatible with a single-field sparse unique index.
import type {SyncTaskMode} from "~~/shared/types/domain"

// Build the stored pair key. It includes the user so the unique index is per account, not global.
export function accountSyncPairStorageKey(userId: string, pairKey: string): string {
    return `${userId}:${pairKey}`
}

// Omit the pair key for playlist tasks. A single-field sparse index then skips them.
export function accountSyncPairField(mode: SyncTaskMode, userId: string, pairKey: string): {accountSyncPairKey: string} | Record<string, never> {
    if (mode !== "account") return {}
    return {accountSyncPairKey: accountSyncPairStorageKey(userId, pairKey)}
}
