// Keep full-sync identity fields compatible with a sparse unique index.
import type {SyncTaskMode} from "~~/shared/types/domain"

// Omit the pair key for playlist tasks. The sparse unique index then ignores them, matching the old partial index.
export function accountSyncPairField(mode: SyncTaskMode, pairKey: string): {accountSyncPairKey: string} | Record<string, never> {
    if (mode !== "account") return {}
    return {accountSyncPairKey: pairKey}
}
