// Shared contracts implemented by each music provider adapter.
import type {Provider, ProviderAccountDocument} from "~~/shared/types/domain"

// A provider playlist summary used by the sync workflow.
export interface ProviderPlaylist {
    id: string
    name: string
    description?: string
    imageUrl?: string
    itemCount: number
}

// A provider track with both display metadata and provider identifiers.
export interface ProviderTrack {
    itemId: string
    trackId: string
    canonicalKey?: string
    title: string
    artists: string[]
    album?: string
    durationMs?: number
    isrc?: string
    imageUrl?: string
}

// Identifiers returned after tracks are added to a playlist.
export interface AddedTrackIds {
    providerTrackId: string
    providerItemId?: string
}

// Progress callback for completed track additions.
export type TrackAdditionProgress = (tracks: AddedTrackIds[]) => Promise<void>

// Progress callback for completed track removals.
export type TrackRemovalProgress = (itemIds: string[]) => Promise<void>

// Operations required to synchronize one provider's playlists.
export interface ProviderAdapter {
    provider: Provider
    listPlaylists(account: ProviderAccountDocument): Promise<ProviderPlaylist[]>
    createPlaylist(account: ProviderAccountDocument, name: string): Promise<ProviderPlaylist>
    deletePlaylist(account: ProviderAccountDocument, playlistId: string): Promise<void>
    getPlaylistItems(account: ProviderAccountDocument, playlistId: string): Promise<ProviderTrack[]>
    searchTrack(account: ProviderAccountDocument, track: ProviderTrack): Promise<ProviderTrack | null>
    addTracks(account: ProviderAccountDocument, playlistId: string, trackIds: string[], onAdded?: TrackAdditionProgress): Promise<void>
    removePlaylistItems(account: ProviderAccountDocument, playlistId: string, itemIds: string[], onRemoved?: TrackRemovalProgress): Promise<void>
}
