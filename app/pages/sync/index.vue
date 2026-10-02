<script setup lang="ts">
import {AlertTriangle, ArrowLeftRight, ArrowRight, CirclePause, ListMusic, LoaderCircle, Play, Plus, RefreshCw, Trash2, X} from "lucide-vue-next"
import type {ConnectedAccount, PlaylistSummary, SyncTaskSummary} from "~/types/api"
import {formatSyncProgressMessage} from "~~/shared/sync-progress"
import {isAwaitingFirstSync, isSyncInProgress, syncTaskBusyMessage} from "~~/shared/sync-task-activity"
import {accountSyncConflictMessage, accountSyncsBlockingAllPairs, allPairsBlockedMessage, findAccountSyncBetweenProviders, type Provider, type SyncTaskDirection} from "~~/shared/types/domain"

definePageMeta({middleware: "auth"})

const auth = useAuthStore()
const {isProviderEnabled} = await useEnabledProviders()
const {data: accountData} = await useFetch<{accounts: ConnectedAccount[]}>("/api/accounts")
const {data: taskData, refresh: refreshTasks} = await useFetch<{tasks: SyncTaskSummary[]}>("/api/tasks")
const showCreate = ref(false)
const sourceAccountId = ref("")
const destinationAccountId = ref("")
const sourcePlaylistId = ref("")
const destinationPlaylistId = ref("")
const syncDirection = ref<SyncTaskDirection>("one-way")
const sourcePlaylists = ref<PlaylistSummary[]>([])
const destinationPlaylists = ref<PlaylistSummary[]>([])
const taskBuilder = useTemplateRef<HTMLElement>("taskBuilder")
const loadingPlaylists = ref(false)
const busyTask = ref("")
const submitting = ref(false)
const errorMessage = ref("")
const showDeleteConfirm = ref(false)
const taskPendingDelete = ref<SyncTaskSummary | null>(null)
const deleteError = ref("")
const allPlaylistsId = "__all__"
const createPlaylistId = "__create__"

const allAccounts = computed(() => accountData.value?.accounts || [])
const accounts = computed(() => allAccounts.value.filter((account) => isProviderEnabled(account.provider)))
const tasks = computed(() =>
    (taskData.value?.tasks || []).filter((task) => {
        const source = allAccounts.value.find((account) => account.id === String(task.source.providerAccountId))
        const destination = allAccounts.value.find((account) => account.id === String(task.destination.providerAccountId))
        return (!source || isProviderEnabled(source.provider)) && (!destination || isProviderEnabled(destination.provider))
    })
)
const taskProviderPairs = computed(() =>
    tasks.value.flatMap((task) => {
        const taskSource = accountProvider(String(task.source.providerAccountId))
        const taskDestination = accountProvider(String(task.destination.providerAccountId))
        if (!taskSource || !taskDestination) return []
        return [{mode: task.mode, sourceProvider: taskSource, destinationProvider: taskDestination}]
    })
)
// With every account pair covered by full syncs, no new task could pass validation, so the builder shows a warning instead.
const blockingFullSyncs = computed(() =>
    accountSyncsBlockingAllPairs(
        taskProviderPairs.value,
        accounts.value.map((account) => account.provider)
    )
)
const canCreate = computed(() => accounts.value.length >= 2 && (auth.user?.tier === "pro" || tasks.value.length === 0))
const syncAllPlaylists = computed(() => sourcePlaylistId.value === allPlaylistsId)
const effectiveDirection = computed<SyncTaskDirection>({
    get: () => (syncAllPlaylists.value ? "one-way" : syncDirection.value),
    set: (value) => {
        if (!syncAllPlaylists.value) syncDirection.value = value
    }
})
const sourcePlaylist = computed(() => sourcePlaylists.value.find((playlist) => playlist.id === sourcePlaylistId.value))
const destinationPlaylist = computed(() => destinationPlaylists.value.find((playlist) => playlist.id === destinationPlaylistId.value))
const createDestinationPlaylist = computed(() => destinationPlaylistId.value === createPlaylistId)
const oneWayLabels = computed(() => effectiveDirection.value === "one-way")
const selectedSourceProvider = computed(() => accountProvider(sourceAccountId.value))
const selectedDestinationProvider = computed(() => accountProvider(destinationAccountId.value))
const conflictingFullSync = computed(() => {
    const sourceProvider = selectedSourceProvider.value
    const destinationProvider = selectedDestinationProvider.value
    if (!sourceProvider || !destinationProvider) return undefined
    return findAccountSyncBetweenProviders(taskProviderPairs.value, sourceProvider, destinationProvider)
})
const fullSyncConflictMessage = computed(() => (conflictingFullSync.value ? accountSyncConflictMessage(conflictingFullSync.value) : ""))
const canSubmit = computed(
    () => !conflictingFullSync.value && !!sourceAccountId.value && !!destinationAccountId.value && (syncAllPlaylists.value ? auth.user?.tier === "pro" : !!sourcePlaylist.value && (!!destinationPlaylist.value || createDestinationPlaylist.value))
)

function accountProvider(accountId: string): Provider | undefined {
    return allAccounts.value.find((account) => account.id === String(accountId))?.provider
}

function selectMatchingDestination() {
    if (!sourcePlaylist.value || !destinationAccountId.value) return
    destinationPlaylistId.value = destinationPlaylists.value.find((playlist) => playlist.name === sourcePlaylist.value?.name)?.id || ""
}

async function openCreate() {
    showCreate.value = true
    await nextTick()
    taskBuilder.value?.scrollIntoView({block: "start"})
}

async function toggleCreate() {
    if (showCreate.value) {
        showCreate.value = false
        return
    }
    await openCreate()
}

async function loadPlaylists(accountId: string, target: "source" | "destination") {
    if (!accountId) return
    loadingPlaylists.value = true
    errorMessage.value = ""
    try {
        const result = await $fetch<{playlists: PlaylistSummary[]}>(`/api/accounts/${accountId}/playlists`)
        if (target === "source") {
            sourcePlaylists.value = result.playlists
            sourcePlaylistId.value = ""
        } else {
            destinationPlaylists.value = result.playlists
            selectMatchingDestination()
        }
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "Playlists could not be loaded"
    } finally {
        loadingPlaylists.value = false
    }
}

watch(sourceAccountId, (value) => loadPlaylists(value, "source"))
watch(destinationAccountId, (value) => loadPlaylists(value, "destination"))
watch(sourcePlaylistId, selectMatchingDestination)

async function createTask() {
    if (!canSubmit.value) return
    submitting.value = true
    errorMessage.value = ""
    try {
        await api("/api/tasks", {
            method: "POST",
            body: {
                mode: syncAllPlaylists.value ? "account" : "playlist",
                direction: effectiveDirection.value,
                source: {
                    accountId: sourceAccountId.value,
                    playlistId: syncAllPlaylists.value ? allPlaylistsId : sourcePlaylist.value!.id,
                    name: syncAllPlaylists.value ? "ALL Playlists" : sourcePlaylist.value!.name,
                    description: sourcePlaylist.value?.description
                },
                destination: {
                    accountId: destinationAccountId.value,
                    playlistId: syncAllPlaylists.value ? allPlaylistsId : createDestinationPlaylist.value ? createPlaylistId : destinationPlaylist.value!.id,
                    name: syncAllPlaylists.value ? "ALL Playlists" : createDestinationPlaylist.value ? sourcePlaylist.value!.name : destinationPlaylist.value!.name,
                    createNew: createDestinationPlaylist.value
                }
            }
        })
        showCreate.value = false
        sourceAccountId.value = ""
        destinationAccountId.value = ""
        syncDirection.value = "one-way"
        await refreshTasks()
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "The sync task could not be created"
    } finally {
        submitting.value = false
    }
}

async function taskAction(task: SyncTaskSummary, action: "run" | "pause" | "resume") {
    busyTask.value = task.id
    errorMessage.value = ""
    try {
        if (action === "run") await api(`/api/tasks/${task.id}/run`, {method: "POST"})
        if (action === "pause" || action === "resume") {
            await api(`/api/tasks/${task.id}`, {
                method: "PATCH",
                body: {status: action === "pause" ? "paused" : "active"}
            })
        }
        await refreshTasks()
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "The task action failed"
    } finally {
        busyTask.value = ""
    }
}

function providerFor(accountId: string) {
    return accounts.value.find((account) => account.id === String(accountId))?.provider || "spotify"
}

function formatDate(value?: string) {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "Not run yet"
}

function manualSyncAvailableAt(task: SyncTaskSummary) {
    if (auth.user?.tier !== "free" || !task.lastSuccessAt) return undefined
    const availableAt = new Date(task.lastSuccessAt).getTime() + 24 * 60 * 60 * 1000
    return availableAt > Date.now() ? new Date(availableAt) : undefined
}

function runTitle(task: SyncTaskSummary) {
    const availableAt = manualSyncAvailableAt(task)
    return availableAt ? `Run available ${formatDate(availableAt.toISOString())}` : "Run now"
}

function isOneWay(task: SyncTaskSummary) {
    return task.direction === "one-way"
}

function syncProgressMessage(task: SyncTaskSummary) {
    if (task.latestRun?.status === "running") {
        return formatSyncProgressMessage(task.mode, task.latestRun.progress)
    }
    return "Sync in progress..."
}

function hasSharedName(task: SyncTaskSummary) {
    return task.source.name === task.destination.name
}

function isEntitlementLocked(task: SyncTaskSummary) {
    return Boolean(task.entitlementLocked) || task.pauseReason === "entitlement"
}

function taskPairLabel(task: SyncTaskSummary) {
    return hasSharedName(task) ? task.source.name : `${task.source.name} and ${task.destination.name}`
}

const deletingTask = ref(false)

// Ask before removing a sync task and its run history.
function openDeleteConfirm(task: SyncTaskSummary) {
    taskPendingDelete.value = task
    deleteError.value = ""
    showDeleteConfirm.value = true
}

function closeDeleteConfirm() {
    if (deletingTask.value) return
    showDeleteConfirm.value = false
}

// Remove the task only after the confirmation dialog is accepted.
async function confirmDelete() {
    const task = taskPendingDelete.value
    if (!task || deletingTask.value || pendingDeleteIsRunning.value) return
    deletingTask.value = true
    deleteError.value = ""
    try {
        await api(`/api/tasks/${task.id}`, {method: "DELETE"})
        showDeleteConfirm.value = false
        await refreshTasks()
    } catch (error) {
        deleteError.value = error instanceof Error ? error.message : "The sync task could not be deleted"
    } finally {
        deletingTask.value = false
        if (!showDeleteConfirm.value) taskPendingDelete.value = null
    }
}

watch(showDeleteConfirm, (open) => {
    if (open || deletingTask.value) return
    deleteError.value = ""
    taskPendingDelete.value = null
})

const progressPollMs = 3000
const shouldPollTasks = computed(() => tasks.value.some((task) => isSyncInProgress(task) || isAwaitingFirstSync(task)))
const pendingDeleteIsRunning = computed(() => {
    const pending = taskPendingDelete.value
    if (!pending) return false
    const fresh = tasks.value.find((task) => task.id === pending.id) || pending
    return isSyncInProgress(fresh)
})
let progressPollTimer: ReturnType<typeof setInterval> | undefined

watch(
    shouldPollTasks,
    (active) => {
        if (import.meta.server) return
        if (active) {
            if (!progressPollTimer) {
                progressPollTimer = setInterval(() => {
                    refreshTasks()
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
})
</script>

<template>
    <div class="shell page-shell sync-page">
        <PageHeading title="My Sync Tasks" description="Pair playlists, keep them aligned on a schedule, and inspect run history on PRO.">
            <template #actions
                ><button class="button button-primary" type="button" :disabled="!canCreate" @click="toggleCreate"><X v-if="showCreate" :size="17" /><Plus v-else :size="17" />{{ showCreate ? "Close" : "New sync task" }}</button></template
            >
        </PageHeading>

        <div v-if="errorMessage" class="notice notice-error" role="alert"><AlertTriangle :size="18" />{{ errorMessage }}</div>
        <div v-if="!canCreate && accounts.length < 2" class="notice">
            <span>Connect at least two music services before creating a pair.</span><NuxtLink to="/account">Open connections <ArrowRight :size="16" /></NuxtLink>
        </div>
        <div v-else-if="!canCreate && auth.user?.tier === 'free'" class="notice">
            <span>Your Free plan includes one active playlist pair.</span><NuxtLink to="/account">See PRO <ArrowRight :size="16" /></NuxtLink>
        </div>
        <div v-else-if="showCreate && canCreate && blockingFullSyncs.length" class="notice notice-warning" role="alert"><AlertTriangle :size="18" />{{ allPairsBlockedMessage(blockingFullSyncs) }}</div>

        <section v-if="showCreate && canCreate && !blockingFullSyncs.length" id="task-builder" ref="taskBuilder" class="task-builder" aria-labelledby="builder-heading">
            <div class="builder-heading">
                <div>
                    <p class="eyebrow light">New sync task</p>
                    <h2 id="builder-heading">Choose playlists</h2>
                </div>
                <RefreshCw :size="25" />
            </div>
            <div class="builder-grid">
                <label
                    ><span>{{ oneWayLabels ? "Master account" : "Source account" }}</span
                    ><select v-model="sourceAccountId">
                        <option value="">Choose account</option>
                        <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.provider }} · {{ account.displayName }}</option>
                    </select></label
                >
                <label
                    ><span>{{ oneWayLabels ? "Master playlist" : "Source playlist" }}</span
                    ><select v-model="sourcePlaylistId" :disabled="!sourceAccountId || loadingPlaylists">
                        <option value="">Choose playlist</option>
                        <option :value="allPlaylistsId" :disabled="auth.user?.tier !== 'pro'">ALL Playlists{{ auth.user?.tier === "pro" ? "" : " (PRO)" }}</option>
                        <option v-for="playlist in sourcePlaylists" :key="playlist.id" :value="playlist.id">{{ playlist.name }} ({{ playlist.itemCount }})</option>
                    </select></label
                >
                <div class="builder-arrow">
                    <RefreshCw v-if="effectiveDirection === 'two-way'" :size="22" />
                    <ArrowRight v-else :size="22" />
                </div>
                <label
                    ><span>{{ oneWayLabels ? "Mirror account" : "Destination account" }}</span
                    ><select v-model="destinationAccountId">
                        <option value="">Choose account</option>
                        <option v-for="account in accounts.filter((item) => item.id !== sourceAccountId)" :key="account.id" :value="account.id">{{ account.provider }} · {{ account.displayName }}</option>
                    </select></label
                >
                <label
                    ><span>{{ oneWayLabels ? "Mirror playlist" : "Destination playlist" }}</span
                    ><select v-model="destinationPlaylistId" :disabled="!destinationAccountId || loadingPlaylists || syncAllPlaylists">
                        <option v-if="syncAllPlaylists" value="">Auto</option>
                        <option value="">Choose playlist</option>
                        <option v-if="sourcePlaylist" :value="createPlaylistId">Create new playlist: {{ sourcePlaylist.name }}</option>
                        <option v-for="playlist in destinationPlaylists" :key="playlist.id" :value="playlist.id">{{ playlist.name }} ({{ playlist.itemCount }})</option>
                    </select></label
                >
            </div>
            <div v-if="fullSyncConflictMessage" class="notice notice-warning" role="alert"><AlertTriangle :size="18" />{{ fullSyncConflictMessage }}</div>
            <fieldset class="direction-picker">
                <legend class="sr-only">Sync direction</legend>
                <label class="direction-option" :class="{selected: effectiveDirection === 'one-way'}">
                    <input v-model="effectiveDirection" type="radio" name="sync-direction" value="one-way" />
                    <strong><ArrowRight :size="16" /> One-way</strong>
                    <span> The first playlist is the master. The second playlist mirrors it and is never copied back. </span>
                </label>
                <label class="direction-option" :class="{selected: effectiveDirection === 'two-way', disabled: syncAllPlaylists}">
                    <input v-model="effectiveDirection" type="radio" name="sync-direction" value="two-way" :disabled="syncAllPlaylists" />
                    <strong><RefreshCw :size="16" /> Two-way</strong>
                    <span v-if="syncAllPlaylists">Two-way is not supported when syncing all playlists from a provider.</span>
                    <span v-else>Both playlists stay equal. Additions and removals travel in either direction.</span>
                </label>
            </fieldset>
            <div class="builder-footer">
                <p v-if="syncAllPlaylists">Playlists are matched by name. Missing playlists are created and removed master playlists are deleted from the mirrored account.</p>
                <p v-else-if="effectiveDirection === 'one-way'">Later runs copy the master's additions and removals onto the mirror playlist only.</p>
                <p v-else>The first run copies missing source tracks. Later runs reconcile changes in both directions.</p>
                <button class="button button-light" type="button" :disabled="!canSubmit || submitting" @click="createTask"><LoaderCircle v-if="submitting" class="spin" :size="17" />Create sync task</button>
            </div>
        </section>

        <section v-if="tasks.length" class="task-list" aria-label="Playlist sync tasks">
            <article v-for="task in tasks" :key="task.id" class="task-card">
                <div class="task-card-head">
                    <h3 class="task-title" :class="{split: !hasSharedName(task)}">
                        <template v-if="hasSharedName(task)">{{ task.source.name }}</template>
                        <template v-else>
                            <span>{{ task.source.name }}</span>
                            <ArrowRight v-if="isOneWay(task)" class="task-title-arrow" :size="16" />
                            <ArrowLeftRight v-else class="task-title-arrow" :size="16" />
                            <span>{{ task.destination.name }}</span>
                        </template>
                    </h3>
                    <div class="task-providers">
                        <ProviderBadge :provider="providerFor(task.source.providerAccountId)" />
                        <span class="sync-direction">
                            <ArrowRight v-if="isOneWay(task)" :size="15" />
                            <ArrowLeftRight v-else :size="15" />
                            <span class="sr-only">{{ isOneWay(task) ? "mirrors to" : "syncs with" }}</span>
                        </span>
                        <ProviderBadge :provider="providerFor(task.destination.providerAccountId)" />
                    </div>
                    <div class="task-actions">
                        <NuxtLink class="icon-button" :class="{'has-alert': Boolean(task.latestRun?.skipped)}" :to="`/sync/${task.id}`" title="View run details">
                            <ListMusic :size="18" />
                        </NuxtLink>
                        <button
                            v-if="!isEntitlementLocked(task)"
                            class="icon-button"
                            type="button"
                            :title="isSyncInProgress(task) ? syncTaskBusyMessage : runTitle(task)"
                            :disabled="busyTask === task.id || isSyncInProgress(task) || task.status === 'paused' || !!manualSyncAvailableAt(task)"
                            @click="taskAction(task, 'run')"
                        >
                            <LoaderCircle v-if="busyTask === task.id || isSyncInProgress(task)" class="spin" :size="18" /><Play v-else :size="18" />
                        </button>
                        <button
                            v-if="!isEntitlementLocked(task)"
                            class="icon-button"
                            type="button"
                            :title="isSyncInProgress(task) ? syncTaskBusyMessage : task.status === 'paused' ? 'Resume' : 'Pause'"
                            :disabled="busyTask === task.id || isSyncInProgress(task)"
                            @click="taskAction(task, task.status === 'paused' ? 'resume' : 'pause')"
                        >
                            <Play v-if="task.status === 'paused'" :size="18" /><CirclePause v-else :size="18" />
                        </button>
                        <button
                            class="icon-button danger"
                            type="button"
                            :title="isSyncInProgress(task) ? syncTaskBusyMessage : 'Delete task'"
                            aria-haspopup="dialog"
                            :aria-expanded="showDeleteConfirm && taskPendingDelete?.id === task.id"
                            :disabled="busyTask === task.id || isSyncInProgress(task)"
                            @click="openDeleteConfirm(task)"
                        >
                            <Trash2 :size="18" />
                        </button>
                    </div>
                </div>
                <div class="task-meta">
                    <span class="status-label" :class="`status-${isSyncInProgress(task) ? 'running' : task.status}`"><span />{{ isSyncInProgress(task) ? "running" : task.status.replace("_", " ") }}</span>
                    <span>{{ isOneWay(task) ? "One-way" : "Two-way" }}</span>
                    <span>{{ task.status === "paused" ? "Paused" : `Next ${formatDate(task.nextRunAt)}` }}</span>
                    <span v-if="isSyncInProgress(task)" class="task-progress"><LoaderCircle class="spin" :size="14" />{{ syncProgressMessage(task) }}</span>
                    <template v-else>
                        <span>Last {{ formatDate(task.lastSuccessAt) }}</span>
                        <span v-if="task.latestRun"
                            >Changes +{{ task.latestRun.additions }} / −{{ task.latestRun.removals }}<template v-if="task.latestRun.conflicts"> · {{ task.latestRun.conflicts }} conflict</template></span
                        >
                    </template>
                    <span v-if="!isSyncInProgress(task) && task.latestRun?.skipped" class="task-unmatched">{{ task.latestRun.skipped }} unmatched</span>
                </div>
                <p v-if="isEntitlementLocked(task)" class="task-entitlement-note">
                    A PRO subscription is needed to enable this sync task.
                    <NuxtLink to="/account">See PRO <ArrowRight :size="14" /></NuxtLink>
                </p>
                <p v-if="task.lastError" class="task-error">{{ task.lastError }}</p>
            </article>
        </section>
        <section v-else-if="!showCreate" class="empty-state">
            <RefreshCw :size="34" />
            <h2>You have no sync tasks yet</h2>
            <p>Ready to start?</p>
            <button v-if="canCreate" class="button button-primary" type="button" @click="openCreate"><Plus :size="17" />Create your first sync task</button>
            <NuxtLink v-else class="button button-secondary" to="/account">Manage connections</NuxtLink>
        </section>
        <OverlayDialog v-model="showDeleteConfirm" title="Delete sync task" :busy="deletingTask">
            <p v-if="taskPendingDelete" class="confirm-dialog-copy">
                Delete <strong>{{ taskPairLabel(taskPendingDelete) }}</strong
                >? This removes the sync task and its run history. Playlists on your music services stay as they are.
            </p>
            <p v-if="deleteError" class="dialog-error" role="alert">{{ deleteError }}</p>
            <div class="dialog-actions">
                <button class="button button-secondary" type="button" :disabled="deletingTask" @click="closeDeleteConfirm">Cancel</button>
                <button class="button button-danger" type="button" :disabled="deletingTask || pendingDeleteIsRunning" @click="confirmDelete">
                    <LoaderCircle v-if="deletingTask" class="spin" :size="17" />
                    Delete task
                </button>
            </div>
        </OverlayDialog>
    </div>
</template>
