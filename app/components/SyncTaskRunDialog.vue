<!-- Details overlay for a sync task's latest run, with PRO history browsing. -->

<script setup lang="ts">
import {ArrowLeftRight, ArrowRight, LoaderCircle} from "lucide-vue-next"
import type {Provider} from "~~/shared/types/domain"
import type {SyncRunDetail, SyncRunTrack, SyncTaskSummary} from "~/types/api"

const open = defineModel<boolean>({required: true})
const props = defineProps<{
    task: SyncTaskSummary | null
    sourceProvider: Provider
    destinationProvider: Provider
}>()

const canViewHistory = computed(() => useAuthStore().user?.tier === "pro")
const loading = ref(false)
const errorMessage = ref("")
const canBrowseHistory = ref(false)
const runs = ref<SyncRunDetail[]>([])
const selectedRunId = ref("")

const dialogTitle = computed(() => {
    const task = props.task
    if (!task) return "Sync details"
    return task.source.name === task.destination.name ? task.source.name : `${task.source.name} · ${task.destination.name}`
})
const selectedRun = computed(() => runs.value.find((run) => run.id === selectedRunId.value) || runs.value[0])

function formatDate(value?: string) {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "Not run yet"
}

function formatTrack(track: SyncRunTrack) {
    return track.artists.length ? `${track.title} — ${track.artists.join(", ")}` : track.title
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

async function loadRuns() {
    if (!props.task) return
    loading.value = true
    errorMessage.value = ""
    try {
        const result = await $fetch<{canBrowseHistory: boolean; runs: SyncRunDetail[]}>(`/api/tasks/${props.task.id}/runs`)
        canBrowseHistory.value = result.canBrowseHistory
        runs.value = result.runs
        selectedRunId.value = result.runs[0]?.id || ""
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "Run details could not be loaded"
        runs.value = []
        selectedRunId.value = ""
    } finally {
        loading.value = false
    }
}

watch([open, () => props.task?.id], ([isOpen]) => {
    if (isOpen) loadRuns()
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
                            <li v-for="(track, trackIndex) in group.tracks" :key="`added-${groupIndex}-${trackIndex}`">{{ formatTrack(track) }}</li>
                        </template>
                    </ul>
                </section>

                <section class="run-track-section" aria-labelledby="removed-heading">
                    <h3 id="removed-heading">Removed ({{ selectedRun.removedTracks.length }})</h3>
                    <p v-if="!selectedRun.removedTracks.length" class="run-track-empty">No tracks were removed.</p>
                    <ul v-else class="run-track-list">
                        <template v-for="(group, groupIndex) in groupedTracks(selectedRun.removedTracks)" :key="`removed-${groupIndex}`">
                            <li v-if="group.name" class="run-track-playlist">{{ group.name }}</li>
                            <li v-for="(track, trackIndex) in group.tracks" :key="`removed-${groupIndex}-${trackIndex}`">{{ formatTrack(track) }}</li>
                        </template>
                    </ul>
                </section>

                <section class="run-track-section unmatched" aria-labelledby="unmatched-heading">
                    <h3 id="unmatched-heading">Unmatched ({{ selectedRun.unmatchedTracks.length || selectedRun.skipped }})</h3>
                    <p v-if="selectedRun.unmatchedTracks.length || selectedRun.skipped" class="run-track-note">These tracks could not be found on the other service, so they were not copied.</p>
                    <p v-if="!selectedRun.unmatchedTracks.length && !selectedRun.skipped" class="run-track-empty">Every track was matched.</p>
                    <p v-else-if="!selectedRun.unmatchedTracks.length" class="run-track-empty">This run skipped {{ selectedRun.skipped }} {{ selectedRun.skipped === 1 ? "track" : "tracks" }}, but individual titles were not stored.</p>
                    <ul v-else class="run-track-list">
                        <template v-for="(group, groupIndex) in groupedTracks(selectedRun.unmatchedTracks)" :key="`unmatched-${groupIndex}`">
                            <li v-if="group.name" class="run-track-playlist">{{ group.name }}</li>
                            <li v-for="(track, trackIndex) in group.tracks" :key="`unmatched-${groupIndex}-${trackIndex}`">{{ formatTrack(track) }}</li>
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
