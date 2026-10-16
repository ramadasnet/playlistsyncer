<!-- Run history for one sync task. -->

<script setup lang="ts">
import {ArrowLeft, ArrowLeftRight, ArrowRight, ExternalLink, LoaderCircle, Search, Undo2} from "lucide-vue-next"
import {catalogSearchLabel} from "~~/shared/catalog-search"
import {formatDuration} from "~~/shared/format-duration"
import {formatSyncProgressMessage} from "~~/shared/sync-progress"
import {formatRunPlaylistLabel, groupRunPlaylists, trackInRunPlaylist} from "~~/shared/sync-run-playlists"
import {isSyncInProgress, syncTaskBusyMessage} from "~~/shared/sync-task-activity"
import {isUnavailableSyncTrack, unmatchedCategoryCounts} from "~~/shared/unavailable-tracks"
import {finishedRestoreMessage, type ReverseSyncReason} from "~~/shared/reverse-sync"
import {providerDisplayNames, type Provider} from "~~/shared/types/domain"
import type {SimilarTrackSuggestion, SyncRunDetail, SyncRunTrack, SyncTaskDetail} from "~/types/api"

definePageMeta({middleware: "auth"})

const route = useRoute()
const taskId = computed(() => String(route.params.id || ""))
const {data, error, pending, refresh} = await useFetch<SyncTaskDetail>(() => `/api/tasks/${taskId.value}`)

const allPlaylistsKey = "__all__"
const selectedRunId = ref("")
const restoring = ref(false)
const restoreError = ref("")
const restoreMessage = ref("")
let keepRestoreMessage = false
let restoreRunId = ""
const selectedPlaylistKey = ref(allPlaylistsKey)
const suggestionLimit = 5
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
            searchText?: string
            submittedQuery?: string
        }
    >
>({})

const task = computed(() => data.value?.task)
const runs = computed(() => data.value?.runs || [])
const taskIsRunning = computed(() => Boolean(task.value && isSyncInProgress(task.value)))
const sourceProvider = computed(() => data.value?.sourceProvider || undefined)
const destinationProvider = computed(() => data.value?.destinationProvider || undefined)
const canBrowseHistory = computed(() => Boolean(data.value?.canBrowseHistory))
const showRunPicker = computed(() => runs.value.length > 1 && (canBrowseHistory.value || runs.value.some((run) => run.availableReverseSync)))
const canViewHistory = computed(() => useAuthStore().user?.tier === "pro")
const selectedRun = computed(() => runs.value.find((run) => run.id === selectedRunId.value) || runs.value[0])
const pageTitle = computed(() => {
    const current = task.value
    if (!current) return "Sync run"
    return current.source.name === current.destination.name ? current.source.name : `${current.source.name} · ${current.destination.name}`
})
useSeoMeta({title: pageTitle})
const pageDescription = computed(() => (task.value?.direction === "one-way" ? "One-way sync" : "Two-way sync"))
const loadError = computed(() => {
    if (!error.value) return ""
    const fetchError = error.value as {data?: {statusMessage?: string}; statusMessage?: string}
    return fetchError.data?.statusMessage || fetchError.statusMessage || "Run details could not be loaded"
})

type PlaylistOption = ReturnType<typeof groupRunPlaylists>[number]

function providerForTrack(track: SyncRunTrack) {
    const current = task.value
    if (!current) return undefined
    const source = sourceProvider.value || undefined
    const destination = destinationProvider.value || undefined
    if (track.providerAccountId && track.providerAccountId === current.source.providerAccountId) return source
    if (track.providerAccountId && track.providerAccountId === current.destination.providerAccountId) return destination
    if (track.side === "source") return source
    if (track.side === "destination") return destination
    return undefined
}

function describedTrack(track: SyncRunTrack) {
    const provider = providerForTrack(track)
    return provider ? {...track, provider} : track
}

const playlistOptions = computed((): PlaylistOption[] => {
    const current = task.value
    const run = selectedRun.value
    if (!current || !run) return []
    return groupRunPlaylists({
        mode: current.mode,
        source: current.source,
        destination: current.destination,
        playlistMappings: data.value?.playlistMappings,
        addedTracks: run.addedTracks.map(describedTrack),
        removedTracks: run.removedTracks.map(describedTrack),
        unmatchedTracks: run.unmatchedTracks.map(describedTrack)
    })
})

const showPlaylistPicker = computed(() => playlistOptions.value.length > 1)
const selectedPlaylist = computed(() => playlistOptions.value.find((playlist) => playlist.key === selectedPlaylistKey.value))
const viewingAllPlaylists = computed(() => !showPlaylistPicker.value || selectedPlaylistKey.value === allPlaylistsKey || !selectedPlaylist.value)

function trackInSelectedPlaylist(track: SyncRunTrack) {
    if (viewingAllPlaylists.value) return true
    return trackInRunPlaylist(track, selectedPlaylist.value)
}

const playlistUnmatched = computed(() => {
    const run = selectedRun.value
    if (!run) return []
    return run.unmatchedTracks.map((track, index) => ({track, index})).filter(({track}) => trackInSelectedPlaylist(track))
})
const filteredUnmatched = computed(() => playlistUnmatched.value.filter(({track}) => !isUnavailableSyncTrack(describedTrack(track))))
const filteredUnavailable = computed(() => playlistUnmatched.value.filter(({track}) => isUnavailableSyncTrack(describedTrack(track))))
const filteredAdded = computed(() => selectedRun.value?.addedTracks.filter(trackInSelectedPlaylist) || [])
const filteredRemoved = computed(() => selectedRun.value?.removedTracks.filter(trackInSelectedPlaylist) || [])
const showPlaylistColumn = computed(() => viewingAllPlaylists.value && playlistOptions.value.length > 1)
const addedRows = computed(() => filteredAdded.value.map((track, index) => ({track, index})))
const removedRows = computed(() => filteredRemoved.value.map((track, index) => ({track, index})))
const titlesWereNotStored = computed(() => {
    const run = selectedRun.value
    return Boolean(run && run.skipped > 0 && !run.unmatchedTracks.length)
})
const selectedPlaylistUnmatchedCount = computed(() => {
    if (!selectedRun.value) return 0
    if (selectedRun.value.unmatchedTracks.length) return filteredUnmatched.value.length
    if (viewingAllPlaylists.value) return selectedRun.value.skipped
    return 0
})

function formatDate(value?: string) {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "Not run yet"
}

function formatTrack(track: Pick<SyncRunTrack, "title" | "artists">) {
    return track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title
}

function runOptionLabel(run: SyncRunDetail) {
    const changes = [`+${run.additions}`, `-${run.removals}`]
    const counts = unmatchedCategoryCounts(run.skipped, run.unmatchedTracks.map(describedTrack))
    const parts = [formatDate(run.startedAt), run.status.replace("_", " "), changes.join(" / ")]
    if (counts.unmatched) parts.push(`${counts.unmatched} unmatched`)
    if (counts.unavailable) parts.push(`${counts.unavailable} unavailable`)
    return parts.join(" · ")
}

function triggerLabel(run: SyncRunDetail) {
    if (run.reverseSync?.reason === "deleted-source") return "Source restore"
    if (run.trigger === "created") return "First run"
    if (run.trigger === "manual") return "Manual"
    return "Scheduled"
}

function reverseSyncLabel(reason: ReverseSyncReason) {
    if (reason === "deleted-source") return "Restore source playlist"
    return "Run reverse sync"
}

function reverseSyncCopy(reason: ReverseSyncReason) {
    if (reason === "deleted-source") return "The source playlist is missing. Restore it once by copying the target playlist back. Later syncs keep their usual direction."
    return "Run a one-time reverse sync."
}

async function restoreSource() {
    const plan = selectedRun.value?.availableReverseSync
    if (!task.value || !plan || restoring.value || taskIsRunning.value) return
    restoring.value = true
    restoreError.value = ""
    restoreMessage.value = ""
    try {
        const started = await api<{runId: string}>(`/api/tasks/${task.value.id}/reverse-sync`, {method: "POST", body: plan})
        await refresh()
        keepRestoreMessage = selectedRunId.value !== started.runId
        selectedRunId.value = started.runId
        restoreRunId = started.runId
        restoreMessage.value = "Restoring the source playlist from the target. Later syncs keep their usual direction."
    } catch (caught) {
        restoreError.value = statusMessage(caught, "The source playlist could not be restored")
    } finally {
        restoring.value = false
    }
}

function unmatchedKey(track: SyncRunTrack, index: number) {
    return `${track.playlistId || ""}:${track.providerItemId || ""}:${track.providerTrackId || ""}:${index}`
}

function canSuggest(track: SyncRunTrack) {
    return Boolean(track.playlistId && track.providerTrackId)
}

function statusMessage(caught: unknown, fallback: string) {
    if (caught && typeof caught === "object") {
        const payload = (caught as {data?: {statusMessage?: string}}).data
        if (payload?.statusMessage) return payload.statusMessage
    }
    return caught instanceof Error ? caught.message : fallback
}

function targetProviderFor(track: SyncRunTrack): Provider {
    if (track.side === "destination" && sourceProvider.value) return sourceProvider.value
    if (destinationProvider.value) return destinationProvider.value
    return sourceProvider.value || "spotify"
}

const showMatchDialog = ref(false)
const matchTarget = ref<{track: SyncRunTrack; index: number} | null>(null)
const matchAlert = ref<{tone: "success" | "error"; message: string} | null>(null)
const matchQuery = ref("")
const matchQueryEdited = ref(false)
const matchKey = computed(() => (matchTarget.value ? unmatchedKey(matchTarget.value.track, matchTarget.value.index) : ""))
const matchState = computed(() => suggestionState.value[matchKey.value])
const visibleSuggestions = computed(() => matchState.value?.suggestions?.slice(0, suggestionLimit))
const canSubmitMatchQuery = computed(() => Boolean(matchQuery.value.trim()) && !matchState.value?.loading && !matchState.value?.matchingId && !taskIsRunning.value)
let matchAlertTimer: ReturnType<typeof setTimeout> | undefined
const suggestionRequests = new Map<string, number>()

function showMatchAlert(tone: "success" | "error", message: string) {
    matchAlert.value = {tone, message}
    clearTimeout(matchAlertTimer)
    matchAlertTimer = setTimeout(() => {
        matchAlert.value = null
    }, 4500)
}

function defaultMatchQuery(track: SyncRunTrack) {
    return catalogSearchLabel(targetProviderFor(track), track)
}

function openMatchDialog(track: SyncRunTrack, index: number) {
    if (taskIsRunning.value) return
    const state = suggestionState.value[unmatchedKey(track, index)]
    matchTarget.value = {track, index}
    matchQuery.value = state?.submittedQuery || state?.searchText || defaultMatchQuery(track)
    matchQueryEdited.value = Boolean(state?.submittedQuery)
    showMatchDialog.value = true
    if (!state?.suggestions && !state?.loading) loadSuggestions(track, index)
}

function onMatchQueryInput() {
    matchQueryEdited.value = true
}

function submitMatchSearch() {
    if (!matchTarget.value || !canSubmitMatchQuery.value) return
    const query = matchQuery.value.trim()
    matchQuery.value = query
    matchQueryEdited.value = true
    loadSuggestions(matchTarget.value.track, matchTarget.value.index, query)
}

watch(showMatchDialog, (open) => {
    if (!open) matchTarget.value = null
})

async function loadSuggestions(track: SyncRunTrack, index: number, submittedQuery?: string) {
    if (!task.value || !canSuggest(track) || taskIsRunning.value) return
    const key = unmatchedKey(track, index)
    const query = submittedQuery?.trim()
    const requestId = (suggestionRequests.get(key) || 0) + 1
    suggestionRequests.set(key, requestId)
    suggestionState.value = {
        ...suggestionState.value,
        [key]: {loading: true, error: "", searchText: query || suggestionState.value[key]?.searchText, submittedQuery: query}
    }
    try {
        const result = await api<{targetProvider: Provider; targetPlaylistName: string; query: string; suggestions: SimilarTrackSuggestion[]}>(`/api/tasks/${task.value.id}/matches/suggestions`, {
            method: "POST",
            body: {
                runId: selectedRunId.value || undefined,
                playlistId: track.playlistId,
                providerTrackId: track.providerTrackId,
                providerItemId: track.providerItemId,
                ...(query ? {query} : {})
            }
        })
        if (suggestionRequests.get(key) !== requestId) return
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {loading: false, error: "", targetProvider: result.targetProvider, targetPlaylistName: result.targetPlaylistName, suggestions: result.suggestions.slice(0, suggestionLimit), searchText: result.query, submittedQuery: query}
        }
        if (matchKey.value === key && !matchQueryEdited.value) matchQuery.value = result.query
    } catch (caught) {
        if (suggestionRequests.get(key) !== requestId) return
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {loading: false, error: statusMessage(caught, "Similar tracks could not be loaded"), suggestions: [], searchText: query || track.title, submittedQuery: query}
        }
    }
}

async function chooseSuggestion(track: SyncRunTrack, index: number, suggestion: SimilarTrackSuggestion) {
    if (!task.value || !canSuggest(track) || taskIsRunning.value) return
    const key = unmatchedKey(track, index)
    const current = suggestionState.value[key]
    suggestionState.value = {...suggestionState.value, [key]: {...current, loading: false, matchingId: suggestion.trackId, error: ""}}
    let matched = false
    try {
        await api(`/api/tasks/${task.value.id}/matches`, {
            method: "POST",
            body: {
                runId: selectedRunId.value || undefined,
                playlistId: track.playlistId,
                providerTrackId: track.providerTrackId,
                providerItemId: track.providerItemId,
                candidateTrackId: suggestion.trackId,
                ...(current?.submittedQuery ? {query: current.submittedQuery} : {})
            }
        })
        matched = true
        const detail = await $fetch<SyncTaskDetail>(`/api/tasks/${task.value.id}`)
        data.value = detail
        suggestionState.value = {}
        showMatchDialog.value = false
        showMatchAlert("success", `${suggestion.title} was matched.`)
    } catch (caught) {
        if (matched) {
            suggestionState.value = {}
            showMatchDialog.value = false
            showMatchAlert("success", `${suggestion.title} was matched. The updated lists could not be loaded.`)
            return
        }
        suggestionState.value = {
            ...suggestionState.value,
            [key]: {...current, loading: false, matchingId: undefined, error: ""}
        }
        showMatchAlert("error", statusMessage(caught, "The selected track could not be added"))
    }
}

watch(
    runs,
    (next) => {
        if (next.some((run) => run.id === selectedRunId.value)) return
        selectedRunId.value = next[0]?.id || ""
    },
    {immediate: true}
)

watch(selectedRunId, () => {
    suggestionState.value = {}
    if (keepRestoreMessage) {
        keepRestoreMessage = false
        return
    }
    restoreError.value = ""
    restoreMessage.value = ""
})

// Replace the in-progress note once the selected restore run finishes. A failed run shows its own error.
watch(
    () => (selectedRun.value?.id === restoreRunId ? selectedRun.value.status : undefined),
    (status) => {
        if (!status || status === "running" || !restoreMessage.value) return
        restoreRunId = ""
        restoreMessage.value = finishedRestoreMessage(status)
    }
)

watch(playlistOptions, (options) => {
    if (selectedPlaylistKey.value === allPlaylistsKey) return
    if (options.some((option) => option.key === selectedPlaylistKey.value)) return
    selectedPlaylistKey.value = allPlaylistsKey
})

const progressPollMs = 3000
let progressPollTimer: ReturnType<typeof setInterval> | undefined
watch(
    () => runs.value.some((run) => run.status === "running"),
    (active) => {
        if (import.meta.server) return
        if (active) {
            if (!progressPollTimer) {
                progressPollTimer = setInterval(() => {
                    refresh()
                }, progressPollMs)
            }
            return
        }
        if (progressPollTimer) {
            clearInterval(progressPollTimer)
            progressPollTimer = undefined
        }
    },
    {immediate: true}
)

onUnmounted(() => {
    if (progressPollTimer) clearInterval(progressPollTimer)
    clearTimeout(matchAlertTimer)
})
</script>

<template>
    <div class="shell page-shell run-page">
        <NuxtLink class="back-link" to="/sync"><ArrowLeft :size="16" /> My Sync Tasks</NuxtLink>
        <PageHeading :title="pageTitle" :description="pageDescription" />

        <div v-if="matchAlert && !showMatchDialog" class="notice match-alert" :class="matchAlert.tone === 'error' ? 'notice-error' : 'notice-success'" :role="matchAlert.tone === 'error' ? 'alert' : 'status'">{{ matchAlert.message }}</div>

        <p v-if="loadError" class="dialog-error" role="alert">{{ loadError }}</p>
        <div v-else-if="pending && !task" class="run-detail-loading"><LoaderCircle class="spin" :size="22" />Loading run details</div>
        <p v-else-if="!selectedRun">This pair has not run yet.</p>
        <template v-else>
            <div class="run-detail-pair">
                <ProviderBadge v-if="sourceProvider" :provider="sourceProvider" />
                <span class="sync-direction" aria-hidden="true">
                    <ArrowRight v-if="task?.direction === 'one-way'" :size="15" />
                    <ArrowLeftRight v-else :size="15" />
                </span>
                <ProviderBadge v-if="destinationProvider" :provider="destinationProvider" />
            </div>

            <div class="run-detail-filters">
                <label v-if="showRunPicker" class="run-history-picker">
                    <span>Run history</span>
                    <select v-model="selectedRunId">
                        <option v-for="run in runs" :key="run.id" :value="run.id">{{ runOptionLabel(run) }}</option>
                    </select>
                </label>
                <label v-if="showPlaylistPicker" class="run-history-picker">
                    <span>Playlist</span>
                    <select v-model="selectedPlaylistKey">
                        <option :value="allPlaylistsKey">ALL Playlists</option>
                        <option v-for="playlist in playlistOptions" :key="playlist.key" :value="playlist.key">{{ formatRunPlaylistLabel(playlist) }}</option>
                    </select>
                </label>
            </div>

            <div v-if="taskIsRunning" class="notice" role="status">{{ syncTaskBusyMessage }}. Matching and other changes are unavailable until it finishes.</div>

            <div class="run-detail-meta">
                <span class="status-label" :class="`status-${selectedRun.status}`"><span />{{ selectedRun.status.replace("_", " ") }}</span>
                <span>{{ triggerLabel(selectedRun) }}</span>
                <span>{{ formatDate(selectedRun.startedAt) }}</span>
                <span v-if="selectedRun.status === 'running' && task">{{ formatSyncProgressMessage(task.mode, selectedRun.progress) }}</span>
            </div>
            <p v-if="selectedRun.error" class="dialog-error">{{ selectedRun.error }}</p>
            <div v-if="selectedRun.failedPlaylists?.length" class="run-playlist-issues">
                <p class="dialog-error">These playlists could not be synced in this run.{{ selectedRun.status === "failed" ? "" : " The others were synced." }}</p>
                <ul>
                    <li v-for="playlist in selectedRun.failedPlaylists" :key="playlist.sourcePlaylistId">
                        <strong>{{ playlist.name }}</strong
                        ><template v-if="playlist.error">: {{ playlist.error }}</template>
                    </li>
                </ul>
            </div>
            <div v-if="selectedRun.missingSourcePlaylists?.length" class="run-playlist-issues">
                <p class="run-track-note">These playlists are no longer on {{ sourceProvider ? providerDisplayNames[sourceProvider] : "the master account" }}. Their copies on the target were kept.</p>
                <ul>
                    <li v-for="playlist in selectedRun.missingSourcePlaylists" :key="playlist.sourcePlaylistId">{{ playlist.name }}</li>
                </ul>
            </div>
            <div v-if="selectedRun.availableReverseSync || restoreError || restoreMessage" class="run-restore">
                <template v-if="selectedRun.availableReverseSync">
                    <p id="restore-source-copy">{{ reverseSyncCopy(selectedRun.availableReverseSync.reason) }}</p>
                    <button class="button button-primary" type="button" :disabled="restoring || taskIsRunning" aria-describedby="restore-source-copy" @click="restoreSource">
                        <LoaderCircle v-if="restoring" class="spin" :size="16" />
                        <Undo2 v-else :size="16" />
                        {{ reverseSyncLabel(selectedRun.availableReverseSync.reason) }}
                    </button>
                </template>
                <p v-if="restoreError" class="dialog-error" role="alert">{{ restoreError }}</p>
                <p v-if="restoreMessage" role="status">{{ restoreMessage }}</p>
            </div>

            <div class="run-detail-panel">
                <section class="run-track-section unmatched">
                    <h3>Unmatched ({{ selectedPlaylistUnmatchedCount }})</h3>
                    <p v-if="selectedPlaylistUnmatchedCount" class="run-track-note">These tracks could not be found automatically. Search for a close match and add it yourself.</p>
                    <p v-if="!filteredUnmatched.length && !selectedPlaylistUnmatchedCount" class="run-track-empty">{{ filteredUnavailable.length ? "No tracks need a manual match." : "Every track was matched." }}</p>
                    <p v-else-if="!filteredUnmatched.length" class="run-track-empty">This run skipped {{ selectedPlaylistUnmatchedCount }} {{ selectedPlaylistUnmatchedCount === 1 ? "track" : "tracks" }}, but individual titles were not stored.</p>
                    <RunTrackTable v-else :rows="filteredUnmatched" :show-playlist="showPlaylistColumn" actions>
                        <template #actions="{track, index}">
                            <button v-if="canSuggest(track)" class="button button-small button-secondary" type="button" :disabled="taskIsRunning" :title="taskIsRunning ? syncTaskBusyMessage : 'Find similar'" @click="openMatchDialog(track, index)">
                                <Search :size="14" /> Find similar
                            </button>
                        </template>
                    </RunTrackTable>
                </section>

                <section class="run-track-section">
                    <h3>Added ({{ filteredAdded.length }})</h3>
                    <p v-if="!filteredAdded.length" class="run-track-empty">No tracks were added.</p>
                    <RunTrackTable v-else :rows="addedRows" :show-playlist="showPlaylistColumn" />
                </section>

                <section class="run-track-section">
                    <h3>Removed ({{ filteredRemoved.length }})</h3>
                    <p v-if="!filteredRemoved.length" class="run-track-empty">No tracks were removed.</p>
                    <RunTrackTable v-else :rows="removedRows" :show-playlist="showPlaylistColumn" />
                </section>

                <section class="run-track-section unavailable">
                    <h3>Unavailable ({{ filteredUnavailable.length }})</h3>
                    <p v-if="filteredUnavailable.length" class="run-track-note">These YouTube videos were deleted or made private, so they cannot be matched.</p>
                    <p v-else-if="titlesWereNotStored" class="run-track-empty">Individual titles were not stored for this run.</p>
                    <p v-else class="run-track-empty">No deleted or private videos.</p>
                    <RunTrackTable v-if="filteredUnavailable.length" :rows="filteredUnavailable" :show-playlist="showPlaylistColumn" />
                </section>
            </div>

            <p v-if="!canViewHistory" class="task-history-locked">
                Past run history is on PRO.
                <NuxtLink to="/account">See PRO <ArrowRight :size="14" /></NuxtLink>
            </p>

            <OverlayDialog v-model="showMatchDialog" :title="matchTarget ? formatTrack(matchTarget.track) : 'Find a similar track'" wide>
                <div v-if="matchTarget" class="match-dialog">
                    <div v-if="matchAlert?.tone === 'error'" class="notice notice-error" role="alert">{{ matchAlert.message }}</div>
                    <p class="run-track-note">Search for a close match and add it yourself. PlaylistSyncer will keep that pair linked so later syncs do not remove it.</p>
                    <form class="match-search" @submit.prevent="submitMatchSearch">
                        <label class="match-search-field">
                            <span>Search</span>
                            <input v-model="matchQuery" type="text" name="track-title" maxlength="200" autocomplete="off" enterkeyhint="search" :disabled="taskIsRunning || Boolean(matchState?.matchingId)" @input="onMatchQueryInput" />
                        </label>
                        <button class="button button-secondary" type="submit" :disabled="!canSubmitMatchQuery">
                            <Search :size="16" />
                            Search
                        </button>
                    </form>
                    <p v-if="matchState?.loading" class="run-detail-loading" role="status"><LoaderCircle class="spin" :size="18" />Looking for similar tracks</p>
                    <p v-else-if="matchState?.error" class="dialog-error" role="alert">{{ matchState.error }}</p>
                    <p v-else-if="visibleSuggestions && !visibleSuggestions.length" class="run-track-empty">No similar tracks were found on {{ providerDisplayNames[matchState?.targetProvider || targetProviderFor(matchTarget.track)] }}.</p>
                    <ul v-else-if="visibleSuggestions" class="similar-track-list">
                        <li v-for="suggestion in visibleSuggestions" :key="suggestion.trackId" class="similar-track">
                            <img v-if="suggestion.imageUrl" class="similar-track-art" :src="suggestion.imageUrl" :alt="suggestion.title" />
                            <div class="similar-track-copy">
                                <span>{{ formatTrack(suggestion) }}</span>
                                <span v-if="suggestion.album || formatDuration(suggestion.durationMs)" class="similar-track-meta">{{ [suggestion.album, formatDuration(suggestion.durationMs)].filter(Boolean).join(" · ") }}</span>
                            </div>
                            <a
                                v-if="suggestion.url"
                                class="button button-small button-secondary similar-track-link"
                                :href="suggestion.url"
                                target="_blank"
                                rel="noopener noreferrer"
                                :title="`Listen on ${providerDisplayNames[matchState?.targetProvider || targetProviderFor(matchTarget.track)]}`"
                                :aria-label="`Listen to ${suggestion.title} on ${providerDisplayNames[matchState?.targetProvider || targetProviderFor(matchTarget.track)]} (opens in a new window)`"
                            >
                                <ExternalLink :size="14" />
                            </a>
                            <button class="button button-small button-primary" type="button" :disabled="Boolean(matchState?.matchingId) || taskIsRunning" @click="chooseSuggestion(matchTarget.track, matchTarget.index, suggestion)">
                                <LoaderCircle v-if="matchState?.matchingId === suggestion.trackId" class="spin" :size="14" />
                                Add to {{ providerDisplayNames[matchState?.targetProvider || targetProviderFor(matchTarget.track)] }}
                            </button>
                        </li>
                    </ul>
                </div>
            </OverlayDialog>
        </template>
    </div>
</template>
