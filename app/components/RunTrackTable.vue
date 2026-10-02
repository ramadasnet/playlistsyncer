<!-- Tabular list of tracks changed in a sync run. -->

<script setup lang="ts">
import type {SyncRunTrack} from "~/types/api"
import {formatDuration} from "~~/shared/format-duration"

defineProps<{
    rows: {track: SyncRunTrack; index: number}[]
    showPlaylist?: boolean
    actions?: boolean
}>()
</script>

<template>
    <div class="run-track-table-wrap">
        <table class="run-track-table">
            <thead>
                <tr>
                    <th scope="col">Track</th>
                    <th scope="col">Artists</th>
                    <th class="run-track-length" scope="col">Length</th>
                    <th v-if="showPlaylist" scope="col">Playlist</th>
                    <th v-if="actions" class="run-track-action" scope="col"><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="row in rows" :key="`${row.track.playlistId || ''}:${row.track.providerTrackId || ''}:${row.index}`">
                    <td>{{ row.track.title }}</td>
                    <td>{{ row.track.artists.join(", ") || "—" }}</td>
                    <td class="run-track-length">{{ formatDuration(row.track.durationMs) || "—" }}</td>
                    <td v-if="showPlaylist">{{ row.track.playlistName || "—" }}</td>
                    <td v-if="actions" class="run-track-action">
                        <slot name="actions" :track="row.track" :index="row.index" />
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>
