// Merge playlist mappings so a running sync and a saved match do not erase each other.
import type {ObjectId} from "mongodb"
import type {ManualTrackAlias, PlaylistMapping} from "~~/shared/types/domain"
import {collections} from "../../data/collections"

// Combine alias lists, keeping the later copy when both name the same song.
export function mergeManualAliases(current: ManualTrackAlias[] | undefined, incoming: ManualTrackAlias[] | undefined): ManualTrackAlias[] {
    const merged: ManualTrackAlias[] = []
    for (const alias of [...(current || []), ...(incoming || [])]) {
        const index = merged.findIndex((item) => item.canonicalKey === alias.canonicalKey || item.sourceTrackId === alias.sourceTrackId)
        if (index >= 0) merged[index] = alias
        else merged.push(alias)
    }
    return merged
}

function cloneMapping(mapping: PlaylistMapping): PlaylistMapping {
    const manualAliases = mergeManualAliases(mapping.manualAliases, undefined)
    return {
        sourcePlaylistId: mapping.sourcePlaylistId,
        destinationPlaylistId: mapping.destinationPlaylistId,
        name: mapping.name,
        ...(manualAliases.length ? {manualAliases} : {})
    }
}

// Apply structural mapping edits while keeping aliases saved on the other copy.
export function overlayPlaylistMappings(stored: PlaylistMapping[], desired: PlaylistMapping[]): PlaylistMapping[] {
    const next = stored.map(cloneMapping)
    for (const mapping of desired) {
        const existing = next.find((item) => item.sourcePlaylistId === mapping.sourcePlaylistId)
        const manualAliases = mergeManualAliases(mapping.manualAliases, existing?.manualAliases)
        const overlaid: PlaylistMapping = {
            sourcePlaylistId: mapping.sourcePlaylistId,
            destinationPlaylistId: mapping.destinationPlaylistId,
            name: mapping.name,
            ...(manualAliases.length ? {manualAliases} : {})
        }
        if (!existing) {
            next.push(overlaid)
            continue
        }
        existing.destinationPlaylistId = overlaid.destinationPlaylistId
        existing.name = overlaid.name
        if (overlaid.manualAliases) existing.manualAliases = overlaid.manualAliases
        else delete existing.manualAliases
    }
    return next
}

// Save mappings without replacing a concurrent alias or a playlist added by the other writer.
export async function saveMergedPlaylistMappings(taskId: ObjectId, desired: PlaylistMapping[]) {
    const db = await collections()
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const stored = await db.syncTasks.findOne({_id: taskId}, {projection: {playlistMappings: 1, updatedAt: 1}})
        if (!stored) return false
        const next = overlayPlaylistMappings(stored.playlistMappings || [], desired)
        const updatedAt = new Date()
        const result = await db.syncTasks.updateOne(attempt < attempts && stored.updatedAt ? {_id: taskId, updatedAt: stored.updatedAt} : {_id: taskId}, {$set: {playlistMappings: next, updatedAt}})
        if (!result.matchedCount) continue
        for (const mapping of desired) {
            const saved = next.find((item) => item.sourcePlaylistId === mapping.sourcePlaylistId)
            if (saved?.manualAliases?.length) mapping.manualAliases = saved.manualAliases
        }
        return true
    }
    return false
}
