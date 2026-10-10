// Playlists a task writes, shared by task creation and the sync engine.
import type {ObjectId} from "mongodb"
import type {SyncTaskDocument} from "~~/shared/types/domain"

export interface PlaylistWriteRef {
    providerAccountId: ObjectId
    playlistId: string
}

// One claim key per account and playlist. The same playlist on another account is a different key.
export function playlistWriteKey(accountId: ObjectId, playlistId: string): string {
    return `${accountId.toHexString()}:${playlistId}`
}

// Destination, the source when the task is two-way, and every playlist a full sync maps to.
export function writtenPlaylistRefs(task: Pick<SyncTaskDocument, "mode" | "direction" | "source" | "destination" | "playlistMappings">): PlaylistWriteRef[] {
    if (task.mode === "account") {
        return (task.playlistMappings || []).map((mapping) => ({providerAccountId: task.destination.providerAccountId, playlistId: mapping.destinationPlaylistId}))
    }
    return [task.destination, ...(task.direction === "two-way" ? [task.source] : [])].map((side) => ({providerAccountId: side.providerAccountId, playlistId: side.playlistId}))
}

// Keys stored on a playlist-pair task. Full syncs omit the field because their mappings change during a run.
export function storedPlaylistWriteKeys(task: Pick<SyncTaskDocument, "mode" | "direction" | "source" | "destination" | "playlistMappings">): string[] | undefined {
    if (task.mode === "account") return undefined
    const keys = writtenPlaylistRefs(task).map((ref) => playlistWriteKey(ref.providerAccountId, ref.playlistId))
    return keys.length ? keys : undefined
}
