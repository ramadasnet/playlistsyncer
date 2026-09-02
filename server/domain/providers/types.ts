import type {Provider, ProviderAccountDocument} from "~~/shared/types/domain"

export interface ProviderPlaylist {
    id: string
    name: string
    description?: string
    imageUrl?: string
    itemCount: number
}

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

export interface AddedTrackIds {
    providerTrackId: string
    providerItemId?: string
}

export type TrackAdditionProgress = (tracks: AddedTrackIds[]) => Promise<void>
export type TrackRemovalProgress = (itemIds: string[]) => Promise<void>

export interface ProviderAdapter {
    provider: Provider
    listPlaylists(account: ProviderAccountDocument): Promise<ProviderPlaylist[]>
    createPlaylist(account: ProviderAccountDocument, name: string): Promise<ProviderPlaylist>
    deletePlaylist(account: ProviderAccountDocument, playlistId: string): Promise<void>
    getPlaylistItems(account: ProviderAccountDocument, playlistId: string): Promise<ProviderTrack[]>
    searchTrack(account: ProviderAccountDocument, track: ProviderTrack): Promise<ProviderTrack | null>
    addTracks(
        account: ProviderAccountDocument,
        playlistId: string,
        trackIds: string[],
        onAdded?: TrackAdditionProgress
    ): Promise<void>
    removePlaylistItems(
        account: ProviderAccountDocument,
        playlistId: string,
        itemIds: string[],
        onRemoved?: TrackRemovalProgress
    ): Promise<void>
}
