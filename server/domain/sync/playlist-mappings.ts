// Merge playlist mappings so a running sync and a saved match do not erase each other.
import type {ObjectId} from "mongodb"
import type {ManualTrackAlias, PlaylistMapping} from "~~/shared/types/domain"
import {leaseIsActive, syncTaskBusyMessage} from "../../../shared/sync-task-activity"
import {collections} from "../../data/collections"
import {idleLeaseFilter} from "./task-activity"

const mappingConflictMessage = "Playlist mappings changed while they were being saved"

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

// Apply structural mapping edits. The engine keeps stored aliases; a manual match may replace its own.
export function overlayPlaylistMappings(stored: PlaylistMapping[], desired: PlaylistMapping[], options?: {replaceAliases?: boolean}): PlaylistMapping[] {
    const next = stored.map(cloneMapping)
    for (const mapping of desired) {
        const existing = next.find((item) => item.sourcePlaylistId === mapping.sourcePlaylistId)
        const manualAliases = options?.replaceAliases ? mergeManualAliases(existing?.manualAliases, mapping.manualAliases) : existing?.manualAliases || []
        const overlaid: PlaylistMapping = {
            sourcePlaylistId: mapping.sourcePlaylistId,
            destinationPlaylistId: mapping.destinationPlaylistId,
            name: mapping.name,
            ...(manualAliases.length ? {manualAliases} : {})
        }
        if (!existing) {
            next.push(cloneMapping(mapping))
            continue
        }
        existing.destinationPlaylistId = overlaid.destinationPlaylistId
        existing.name = overlaid.name
        if (overlaid.manualAliases) existing.manualAliases = overlaid.manualAliases
        else delete existing.manualAliases
    }
    return next
}

// Every save attempt matches the version we read, and a user save also requires an idle lease.
export function playlistMappingWriteFilter(taskId: ObjectId, updatedAt: Date | undefined, requireIdleLease = false, now = new Date()) {
    const version = updatedAt ? {updatedAt} : {updatedAt: {$exists: false}}
    return {_id: taskId, ...version, ...(requireIdleLease ? idleLeaseFilter(now) : {})}
}

// Save mappings without replacing a concurrent alias or a playlist added by the other writer.
export async function saveMergedPlaylistMappings(taskId: ObjectId, desired: PlaylistMapping[], options?: {replaceAliases?: boolean; requireIdleLease?: boolean}) {
    const db = await collections()
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const stored = await db.syncTasks.findOne({_id: taskId}, {projection: {playlistMappings: 1, updatedAt: 1, leaseExpiresAt: 1}})
        if (!stored) return false
        if (options?.requireIdleLease && leaseIsActive(stored.leaseExpiresAt)) {
            throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
        }
        const next = overlayPlaylistMappings(stored.playlistMappings || [], desired, {replaceAliases: options?.replaceAliases})
        const updatedAt = new Date()
        const result = await db.syncTasks.updateOne(playlistMappingWriteFilter(taskId, stored.updatedAt, options?.requireIdleLease, updatedAt), {$set: {playlistMappings: next, updatedAt}})
        if (!result.matchedCount) continue
        for (const mapping of desired) {
            const saved = next.find((item) => item.sourcePlaylistId === mapping.sourcePlaylistId)
            if (saved?.manualAliases?.length) mapping.manualAliases = saved.manualAliases
        }
        return true
    }
    if (options?.requireIdleLease) {
        const latest = await db.syncTasks.findOne({_id: taskId}, {projection: {leaseExpiresAt: 1}})
        if (latest && leaseIsActive(latest.leaseExpiresAt)) {
            throw createError({statusCode: 409, statusMessage: syncTaskBusyMessage})
        }
    }
    throw createError({statusCode: 409, statusMessage: mappingConflictMessage})
}
