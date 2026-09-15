<!-- Details overlay for a sync task's latest run, with PRO history browsing. -->

<script setup lang="ts">
import {ArrowLeftRight, ArrowRight, LoaderCircle, Search} from "lucide-vue-next"
import {providerDisplayNames, type Provider} from "~~/shared/types/domain"
import type {SimilarTrackSuggestion, SyncRunDetail, SyncRunTrack, SyncTaskSummary} from "~/types/api"

const open = defineModel<boolean>({required: true})
const props = defineProps<{
    task: SyncTaskSummary | null
    sourceProvider: Provider
    destinationProvider: Provider
}>()
const emit = defineEmits<{matched: []}>()

const canViewHistory = computed(() => useAuthStore().user?.tier === "pro")
const loading = ref(false)
const errorMessage = ref("")
const canBrowseHistory = ref(false)
const runs = ref<SyncRunDetail[]>([])
const selectedRunId = ref("")
const suggestionState = ref<
    Record<
        string,
        {
            loading: boolean
            matchingId?: string
            error: string
            targetProvider?: Provider
            targetPlaylistName?: string
            suggestions?: SimilarTrackSuggestion[]
        }
    >
>({})

const dialogTitle = computed(() => {
    const task = props.task
    if (!task) return "Sync details"
    return task.source.name === task.destination.name ? task.source.name : `${task.source.name} · ${task.destination.name}`
})
const selectedRun = computed(() => runs.value.find((run) => run.id === selectedRunId.value) || runs.value[0])

function formatDate(value?: string) {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "Not run yet"
}

function formatTrack(track: Pick<SyncRunTrack, "title" | "artists">) {
    return track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title
}

function formatDuration(ms?: number) {
    if (!ms) return ""
    const totalSeconds = Math.round(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function runOptionLabel(run: SyncRunDetail) {
    const changes = [`+${run.additions}`, `−${run.removals}`]
    if (run.skipped) changes.push(`${run.skipped} unmatched`)
    return `${formatDate(run.startedAt)} · ${run.status.replace("_", " ")} · ${changes.join(" / ")}`
}

function triggerLabel(trigger: SyncRunDetail["trigger"]) {
    if (trigger === "created") return "First run"
    if (trigger === "manual") return "Manual"
    return "Scheduled"
}

function groupedTracks(tracks: SyncRunTrack[]) {
    const names = new Set(tracks.map((track) => track.playlistName).filter(Boolean))
    if (names.size <= 1) {
        return [{name: "", tracks}]
    }
    const groups = new Map<string, SyncRunTrack[]>()
    for (const track of tracks) {
        const name = track.playlistName || "Playlist"
        groups.set(name, [...(groups.get(name) || []), track])
    }
    return [...groups].map(([name, grouped]) => ({name, tracks: grouped}))
}

function unmatchedKey(track: SyncRunTrack, index: number) {
    return `${track.playlistId || ""}:${track.providerItemId || ""}:${track.providerTrackId || ""}:${index}`
}

function canSuggest(track: SyncRunTrack) {
    return Boolean(props.task?.mode !== "account" && track.playlistId && track.providerTrackId)
}

function statusMessage(error: unknown, fallback: string) {
    if (error && typeof error === "object") {
        const data = (error as {data?: {statusMessage?: string}}).data
        if (data?.statusMessage) return data.statusMessage
    }
    return error instanceof Error ? error.message : fallback
}

function targetProviderFor(track: SyncRunTrack): Provider {
    return track.side === "destination" ? props.sourceProvider : props.destinationProvider
}

async function loadRuns() {
    if (!props.task) return
    loading.value = true
    errorMessage.value = ""
    suggestionState.value = {}
    try {
        const result = await $fetch<{canBrowseHistory: boolean; runs: SyncRunDetail[]}>(`/api/tasks/${props.task.id}/runs`)
        const previousId = selectedRunId.value
        canBrowseHistory.value = result.canBrowseHistory
        runs.value = result.runs
        selectedRunId.value = result.runs.find((run) => run.id === previousId)?.id || result.runs[0]?.id || ""
    } catch (error) {
        errorMessage.value = statusMessage(error, "Run details could not be loaded")
        runs.value = []
        selectedRunId.value = ""
    } finally {
        loading.value = false
    }
}

async function loadSuggestions(track: SyncRunTrack, index: number) {
    if (!props.task || !canSuggest(track)) return
    const key = unmatchedKey(track, index)
    suggestionState.value = {
        ...suggestionState.value,
        [key]: {loading: true, error: "", suggestions: suggestionState.value[key]?.suggestions}
    }
    try {
        const result = await $fetch<{targetProvider: Provider; targetPlaylistName: string; suggestions: SimilarTrackSuggestion[]}>(`/api/tasks/${props.task.id}/matches/suggestions`, {
            method: "POST",
            body: {
                runId: selectedRunId.value || undefined,
                playlistId: track.playlistId,
                providerTrackId: track.providerTrackId,
                providerItemId: track.providerItemId
            }
        })
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {loading: false, error: "", targetProvider: result.targetProvider, targetPlaylistName: result.targetPlaylistName, suggestions: result.suggestions}
        }
    } catch (error) {
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {loading: false, error: statusMessage(error, "Similar tracks could not be loaded"), suggestions: []}
        }
    }
}

async function chooseSuggestion(track: SyncRunTrack, index: number, suggestion: SimilarTrackSuggestion) {
    if (!props.task || !canSuggest(track)) return
    const key = unmatchedKey(track, index)
    const current = suggestionState.value[key]
    suggestionState.value = {...suggestionState.value, [key]: {...current, loading: false, matchingId: suggestion.trackId, error: ""}}
    try {
        await $fetch(`/api/tasks/${props.task.id}/matches`, {
            method: "POST",
            body: {
                runId: selectedRunId.value || undefined,
                playlistId: track.playlistId,
                providerTrackId: track.providerTrackId,
                providerItemId: track.providerItemId,
                candidateTrackId: suggestion.trackId
            }
        })
        emit("matched")
        await loadRuns()
    } catch (error) {
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {...current, loading: false, matchingId: undefined, error: statusMessage(error, "The selected track could not be added")}
        }
    }
}

watch([open, () => props.task?.id], ([isOpen]) => {
    if (isOpen) loadRuns()
})

watch(selectedRunId, () => {
    suggestionState.value = {}
})
</script>

<template>
    <OverlayDialog v-model="open" :title="dialogTitle" wide>
        <div class="run-dialog">
            <div class="run-dialog-pair">
                <ProviderBadge :provider="sourceProvider" />
                <span class="sync-direction" aria-hidden="true">
                    <ArrowRight v-if="task?.direction === 'one-way'" :size="15" />
                    <ArrowLeftRight v-else :size="15" />
                </span>
                <ProviderBadge :provider="destinationProvider" />
            </div>

            <p v-if="errorMessage" class="dialog-error" role="alert">{{ errorMessage }}</p>
            <div v-else-if="loading" class="run-dialog-loading"><LoaderCircle class="spin" :size="22" />Loading run details</div>
            <p v-else-if="!selectedRun">This pair has not run yet.</p>
            <template v-else>
                <label v-if="canBrowseHistory && runs.length > 1" class="run-history-picker">
                    <span>Run history</span>
                    <select v-model="selectedRunId">
                        <option v-for="run in runs" :key="run.id" :value="run.id">{{ runOptionLabel(run) }}</option>
                    </select>
                </label>
                <div class="run-dialog-meta">
                    <span class="status-label" :class="`status-${selectedRun.status}`"><span />{{ selectedRun.status.replace("_", " ") }}</span>
                    <span>{{ triggerLabel(selectedRun.trigger) }}</span>
                    <span>{{ formatDate(selectedRun.startedAt) }}</span>
                </div>
                <p v-if="selectedRun.error" class="dialog-error">{{ selectedRun.error }}</p>

                <section class="run-track-section" aria-labelledby="added-heading">
                    <h3 id="added-heading">Added ({{ selectedRun.addedTracks.length }})</h3>
                    <p v-if="!selectedRun.addedTracks.length" class="run-track-empty">No tracks were added.</p>
                    <ul v-else class="run-track-list">
                        <template v-for="(group, groupIndex) in groupedTracks(selectedRun.addedTracks)" :key="`added-${groupIndex}`">
                            <li v-if="group.name" class="run-track-playlist">{{ group.name }}</li>
                            <li v-for="(track, trackIndex) in group.tracks" :key="`added-${groupIndex}-${trackIndex}`">
                                <div class="run-track-copy">
                                    <span>{{ formatTrack(track) }}</span>
                                    <span v-if="formatDuration(track.durationMs)" class="run-track-length">{{ formatDuration(track.durationMs) }}</span>
                                </div>
                            </li>
                        </template>
                    </ul>
                </section>

                <section class="run-track-section" aria-labelledby="removed-heading">
                    <h3 id="removed-heading">Removed ({{ selectedRun.removedTracks.length }})</h3>
                    <p v-if="!selectedRun.removedTracks.length" class="run-track-empty">No tracks were removed.</p>
                    <ul v-else class="run-track-list">
                        <template v-for="(group, groupIndex) in groupedTracks(selectedRun.removedTracks)" :key="`removed-${groupIndex}`">
                            <li v-if="group.name" class="run-track-playlist">{{ group.name }}</li>
                            <li v-for="(track, trackIndex) in group.tracks" :key="`removed-${groupIndex}-${trackIndex}`">
                                <div class="run-track-copy">
                                    <span>{{ formatTrack(track) }}</span>
                                    <span v-if="formatDuration(track.durationMs)" class="run-track-length">{{ formatDuration(track.durationMs) }}</span>
                                </div>
                            </li>
                        </template>
                    </ul>
                </section>

                <section class="run-track-section unmatched" aria-labelledby="unmatched-heading">
                    <h3 id="unmatched-heading">Unmatched ({{ selectedRun.unmatchedTracks.length || selectedRun.skipped }})</h3>
                    <p v-if="selectedRun.unmatchedTracks.length || selectedRun.skipped" class="run-track-note">
                        These tracks could not be found automatically.
                        <template v-if="task?.mode !== 'account'"> Search for a close match and add it yourself — PlaylistSyncer will keep that pair linked so later syncs do not remove it.</template>
                    </p>
                    <p v-if="!selectedRun.unmatchedTracks.length && !selectedRun.skipped" class="run-track-empty">Every track was matched.</p>
                    <p v-else-if="!selectedRun.unmatchedTracks.length" class="run-track-empty">This run skipped {{ selectedRun.skipped }} {{ selectedRun.skipped === 1 ? "track" : "tracks" }}, but individual titles were not stored.</p>
                    <ul v-else class="run-track-list unmatched-list">
                        <template v-for="(group, groupIndex) in groupedTracks(selectedRun.unmatchedTracks)" :key="`unmatched-${groupIndex}`">
                            <li v-if="group.name" class="run-track-playlist">{{ group.name }}</li>
                            <li v-for="(track, trackIndex) in group.tracks" :key="unmatchedKey(track, trackIndex)" class="unmatched-track">
                                <div class="unmatched-track-row">
                                    <div class="run-track-copy">
                                        <span>{{ formatTrack(track) }}</span>
                                        <span v-if="formatDuration(track.durationMs)" class="run-track-length">{{ formatDuration(track.durationMs) }}</span>
                                    </div>
                                    <button
                                        v-if="canSuggest(track)"
                                        class="button button-small button-secondary"
                                        type="button"
                                        :disabled="suggestionState[unmatchedKey(track, trackIndex)]?.loading || Boolean(suggestionState[unmatchedKey(track, trackIndex)]?.matchingId)"
                                        @click="loadSuggestions(track, trackIndex)"
                                    >
                                        <LoaderCircle v-if="suggestionState[unmatchedKey(track, trackIndex)]?.loading" class="spin" :size="14" />
                                        <Search v-else :size="14" />
                                        {{ suggestionState[unmatchedKey(track, trackIndex)]?.suggestions ? "Search again" : "Find similar" }}
                                    </button>
                                </div>
                                <p v-if="suggestionState[unmatchedKey(track, trackIndex)]?.error" class="dialog-error" role="alert">{{ suggestionState[unmatchedKey(track, trackIndex)]?.error }}</p>
                                <ul v-else-if="suggestionState[unmatchedKey(track, trackIndex)]?.suggestions" class="similar-track-list">
                                    <li v-if="!suggestionState[unmatchedKey(track, trackIndex)]?.suggestions?.length" class="run-track-empty">
                                        No similar tracks were found on {{ providerDisplayNames[suggestionState[unmatchedKey(track, trackIndex)]?.targetProvider || targetProviderFor(track)] }}.
                                    </li>
                                    <li v-for="suggestion in suggestionState[unmatchedKey(track, trackIndex)]?.suggestions" :key="suggestion.trackId" class="similar-track">
                                        <img v-if="suggestion.imageUrl" class="similar-track-art" :src="suggestion.imageUrl" :alt="suggestion.title" />
                                        <div class="similar-track-copy">
                                            <span>{{ formatTrack(suggestion) }}</span>
                                            <span v-if="suggestion.album || formatDuration(suggestion.durationMs)" class="similar-track-meta">{{ [suggestion.album, formatDuration(suggestion.durationMs)].filter(Boolean).join(" · ") }}</span>
                                        </div>
                                        <button class="button button-small button-primary" type="button" :disabled="Boolean(suggestionState[unmatchedKey(track, trackIndex)]?.matchingId)" @click="chooseSuggestion(track, trackIndex, suggestion)">
                                            <LoaderCircle v-if="suggestionState[unmatchedKey(track, trackIndex)]?.matchingId === suggestion.trackId" class="spin" :size="14" />
                                            Add to {{ providerDisplayNames[suggestionState[unmatchedKey(track, trackIndex)]?.targetProvider || targetProviderFor(track)] }}
                                        </button>
                                    </li>
                                </ul>
                            </li>
                        </template>
                    </ul>
                </section>
            </template>

            <p v-if="!canViewHistory" class="task-history-locked">
                Past run history is on PRO.
                <NuxtLink to="/account">See PRO <ArrowRight :size="14" /></NuxtLink>
            </p>
        </div>
    </OverlayDialog>
</template>
