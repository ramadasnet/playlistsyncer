// Human-readable progress copy for in-flight synchronization runs.
import type {SyncRunProgress, SyncTaskMode} from "./types/domain"

export function formatSyncProgressMessage(mode: SyncTaskMode, progress?: SyncRunProgress): string {
    if (mode === "account" && progress?.playlistsTotal != null) {
        return `${progress.playlistsCompleted ?? 0} out of ${progress.playlistsTotal} playlists synced...`
    }
    if (progress?.tracksTotal != null) {
        return `Syncing ${progress.tracksTotal} tracks...`
    }
    return "Syncing..."
}
