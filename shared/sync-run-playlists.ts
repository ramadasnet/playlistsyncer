// Collapse a sync run's source and destination playlists into one dropdown option per matched pair.
import {isUnavailableSyncTrack} from "./unavailable-tracks"

export interface RunPlaylistRef {
    playlistId?: string
    playlistName?: string
    title?: string
}

export interface RunPlaylistMapping {
    sourcePlaylistId: string
    destinationPlaylistId: string
    name: string
}

export interface RunPlaylistGroup {
    key: string
    name: string
    ids: string[]
    added: number
    removed: number
    unmatched: number
    unavailable: number
}

interface PlaylistGroupBuilder {
    key: string
    name: string
    ids: Set<string>
    added: number
    removed: number
    unmatched: number
    unavailable: number
}

// Label a matched playlist with how many tracks were added, removed, or left unmatched.
export function formatRunPlaylistLabel(group: Pick<RunPlaylistGroup, "name" | "added" | "removed" | "unmatched">) {
    return `${group.name} ${group.added}+ ${group.removed}- ${group.unmatched}?`
}

function registerGroup(groups: Map<string, PlaylistGroupBuilder>, idToKey: Map<string, string>, key: string, name: string, ids: string[]) {
    const label = name.trim() || "Playlist"
    const existing = groups.get(key)
    if (existing) {
        for (const id of ids) {
            if (!id) continue
            existing.ids.add(id)
            idToKey.set(id, key)
        }
        return existing
    }
    const group: PlaylistGroupBuilder = {key, name: label, ids: new Set(ids.filter(Boolean)), added: 0, removed: 0, unmatched: 0, unavailable: 0}
    groups.set(key, group)
    for (const id of group.ids) idToKey.set(id, key)
    return group
}

// One option per matched playlist, combining both providers' tracks and counts.
export function groupRunPlaylists(input: {
    mode: "playlist" | "account"
    source: {playlistId: string; name: string}
    destination: {playlistId: string; name: string}
    playlistMappings?: RunPlaylistMapping[]
    addedTracks: RunPlaylistRef[]
    removedTracks: RunPlaylistRef[]
    unmatchedTracks: RunPlaylistRef[]
}): RunPlaylistGroup[] {
    const groups = new Map<string, PlaylistGroupBuilder>()
    const idToKey = new Map<string, string>()

    if (input.mode === "account") {
        for (const mapping of input.playlistMappings || []) {
            registerGroup(groups, idToKey, mapping.sourcePlaylistId || mapping.name, mapping.name, [mapping.sourcePlaylistId, mapping.destinationPlaylistId])
        }
    } else {
        const name = input.source.name.trim() || input.destination.name.trim() || "Playlist"
        registerGroup(groups, idToKey, input.source.playlistId || name, name, [input.source.playlistId, input.destination.playlistId])
    }

    const resolve = (track: RunPlaylistRef) => {
        if (track.playlistId && idToKey.has(track.playlistId)) return idToKey.get(track.playlistId)!
        const name = track.playlistName?.trim() || ""
        const named = [...groups.values()].find((group) => name && group.name.toLowerCase() === name.toLowerCase())
        if (named) {
            if (track.playlistId) {
                named.ids.add(track.playlistId)
                idToKey.set(track.playlistId, named.key)
            }
            return named.key
        }
        const key = `name:${(name || "Playlist").toLowerCase()}`
        registerGroup(groups, idToKey, key, name || "Playlist", track.playlistId ? [track.playlistId] : [])
        return key
    }

    const count = (tracks: RunPlaylistRef[], field: "added" | "removed") => {
        for (const track of tracks) {
            const group = groups.get(resolve(track))
            if (group) group[field] += 1
        }
    }
    count(input.addedTracks, "added")
    count(input.removedTracks, "removed")
    for (const track of input.unmatchedTracks) {
        const group = groups.get(resolve(track))
        if (!group) continue
        if (isUnavailableSyncTrack(track)) group.unavailable += 1
        else group.unmatched += 1
    }

    return [...groups.values()]
        .filter((group) => group.added || group.removed || group.unmatched || group.unavailable)
        .map((group) => ({key: group.key, name: group.name, ids: [...group.ids], added: group.added, removed: group.removed, unmatched: group.unmatched, unavailable: group.unavailable}))
        .sort((left, right) => left.name.localeCompare(right.name))
}

// True when a run track belongs to the selected matched playlist.
export function trackInRunPlaylist(track: RunPlaylistRef, group: Pick<RunPlaylistGroup, "name" | "ids"> | undefined) {
    if (!group) return true
    if (track.playlistId && group.ids.includes(track.playlistId)) return true
    const name = track.playlistName?.trim().toLowerCase()
    return Boolean(name) && name === group.name.trim().toLowerCase()
}
