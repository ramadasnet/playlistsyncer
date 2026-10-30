<script setup lang="ts">
import {ArrowLeft, ArrowRight, ExternalLink, RefreshCw, Save, Search, Trash2, X} from "lucide-vue-next"
import type {TaskDetail, TaskList} from "../../shared/contracts"
import {errorLabel} from "../utils/format"
const route = useRoute()
const userId = computed(() => (typeof route.query.userId === "string" ? route.query.userId : ""))
const filter = ref(typeof route.query.status === "string" ? route.query.status : "")
const search = ref("")
const appliedSearch = ref("")
const page = ref(1)
const query = computed(() => ({page: page.value, status: filter.value, search: appliedSearch.value, userId: userId.value}))
const {data, status, error, refresh} = await useFetch<TaskList>("/api/tasks", {query})
const dialog = ref<HTMLDialogElement | null>(null)
const detail = ref<TaskDetail | null>(null)
const saving = ref(false)
const loading = ref("")
const failure = ref("")
const notice = ref("")
const form = reactive({status: "active", direction: "one-way", nextRunAt: ""})
watch([filter, userId], () => {
    page.value = 1
})
function searchTasks() {
    appliedSearch.value = search.value
    page.value = 1
}
function fill(result: TaskDetail) {
    detail.value = result
    const date = new Date(result.task.nextRunAt)
    Object.assign(form, {status: result.task.status === "paused" ? "paused" : "active", direction: result.task.direction, nextRunAt: new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)})
}
async function open(id: string) {
    loading.value = id
    failure.value = ""
    notice.value = ""
    try {
        fill(await $fetch<TaskDetail>(`/api/tasks/${id}`))
        dialog.value?.showModal()
    } catch (cause) {
        failure.value = errorLabel(cause)
    } finally {
        loading.value = ""
    }
}
async function update(cancel = false) {
    if (!detail.value) return
    if (cancel && !window.confirm("Cancel future runs of this sync task? Its configuration and history will be retained.")) return
    if (!cancel && form.direction !== detail.value.task.direction && !window.confirm("Change sync direction? Future runs can change playlists on the newly writable side.")) return
    saving.value = true
    failure.value = ""
    notice.value = ""
    try {
        const endpoint = `/api/tasks/${detail.value.task.id}${cancel ? "/cancel" : ""}`
        const result = await $fetch<TaskDetail>(endpoint, {method: cancel ? "POST" : "PATCH", body: cancel ? undefined : {...form, nextRunAt: new Date(form.nextRunAt).toISOString()}})
        fill(result)
        notice.value = cancel ? "Future runs canceled. History retained." : "Task updated."
        await refresh()
    } catch (cause) {
        failure.value = errorLabel(cause)
    } finally {
        saving.value = false
    }
}
async function remove() {
    if (!detail.value) return
    if (!window.confirm("Permanently delete this sync task? Its configuration, run history and snapshots will be removed. Canceling future runs retains them instead.")) return
    saving.value = true
    failure.value = ""
    notice.value = ""
    try {
        await $fetch(`/api/tasks/${detail.value.task.id}`, {method: "DELETE"})
        dialog.value?.close()
        detail.value = null
        notice.value = "Task deleted."
        await refresh()
    } catch (cause) {
        failure.value = errorLabel(cause)
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <div class="page-heading">
        <div>
            <p class="eyebrow">SYNCHRONIZATION</p>
            <h1>Sync tasks</h1>
            <p class="muted">{{ data?.total.toLocaleString() ?? "..." }} matching tasks</p>
        </div>
        <button class="icon-button" title="Refresh tasks" aria-label="Refresh tasks" :disabled="status === 'pending'" @click="refresh()"><RefreshCw :size="20" /></button>
    </div>
    <p v-if="error || (failure && !dialog?.open)" role="alert" class="notice error">{{ error ? errorLabel(error) : failure }}</p>
    <p v-if="notice && !dialog?.open" role="status" class="notice">{{ notice }}</p>
    <NuxtLink v-if="userId" to="/tasks" class="text-link">Clear user filter<X :size="16" /></NuxtLink>
    <form class="toolbar" @submit.prevent="searchTasks">
        <div class="search-field">
            <Search :size="18" /><input v-model="search" type="search" placeholder="Search playlist, task ID or user ID" aria-label="Search tasks" /><button class="icon-button" type="submit" title="Search" aria-label="Search">
                <ArrowRight :size="18" />
            </button>
        </div>
        <select v-model="filter" aria-label="Filter task status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="needs_attention">Needs attention</option>
        </select>
    </form>
    <p v-if="status === 'pending'" class="muted" role="status">Loading tasks...</p>
    <div class="table-scroll">
        <table>
            <thead>
                <tr>
                    <th>Task</th>
                    <th>Owner</th>
                    <th>Status</th>
                    <th>Next run</th>
                    <th><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="task in data?.items" :key="task.id">
                    <td>
                        <strong>{{ task.source }} / {{ task.destination }}</strong
                        ><span class="cell-secondary">{{ task.mode }} / {{ task.direction }}</span>
                    </td>
                    <td>{{ task.owner }}</td>
                    <td>
                        <span class="badge" :class="task.status">{{ task.busy ? "Running" : task.status }}</span
                        ><span v-if="task.pauseReason" class="cell-secondary">{{ task.pauseReason }} pause</span>
                    </td>
                    <td><DateLabel :value="task.nextRunAt" /></td>
                    <td>
                        <button :disabled="!!loading" @click="open(task.id)">{{ loading === task.id ? "Loading..." : "Manage" }}<ExternalLink :size="14" /></button>
                    </td>
                </tr>
                <tr v-if="data && !data.items.length">
                    <td colspan="5" class="empty">No matching tasks.</td>
                </tr>
            </tbody>
        </table>
    </div>
    <div v-if="data" class="pagination">
        <span>Page {{ data.page }} of {{ Math.max(1, Math.ceil(data.total / data.pageSize)) }}</span>
        <div class="actions">
            <button class="icon-button" title="Previous page" aria-label="Previous page" :disabled="page <= 1 || status === 'pending'" @click="page--"><ArrowLeft :size="18" /></button
            ><button class="icon-button" title="Next page" aria-label="Next page" :disabled="page * data.pageSize >= data.total || status === 'pending'" @click="page++"><ArrowRight :size="18" /></button>
        </div>
    </div>
    <dialog ref="dialog" aria-labelledby="task-title" @cancel="saving && $event.preventDefault()">
        <template v-if="detail"
            ><div class="dialog-heading">
                <div>
                    <p class="eyebrow">SYNC TASK / {{ detail.task.id }}</p>
                    <h2 id="task-title">{{ detail.task.source }}</h2>
                    <p class="muted">{{ detail.task.destination }}</p>
                </div>
                <button class="icon-button" title="Close task" aria-label="Close task" :disabled="saving" @click="dialog?.close()"><X :size="20" /></button>
            </div>
            <p v-if="failure" role="alert" class="notice error">{{ failure }}</p>
            <p v-if="notice" role="status" class="notice">{{ notice }}</p>
            <p v-if="detail.task.busy" class="notice">This task holds an active lease. Changes are blocked until it is idle.</p>
            <p v-if="detail.task.pauseReason === 'entitlement'" class="notice">This task is restricted by the owner's subscription.</p>
            <form class="edit-form" @submit.prevent="update()">
                <label
                    >Status<select v-model="form.status">
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                    </select></label
                ><label
                    >Direction<select v-model="form.direction" :disabled="detail.task.mode === 'account'">
                        <option value="one-way">One-way</option>
                        <option value="two-way">Two-way</option>
                    </select></label
                ><label>Next run (local time)<input v-model="form.nextRunAt" type="datetime-local" required /></label>
                <div class="actions">
                    <button class="primary" :disabled="saving || detail.task.busy"><Save :size="16" />Save task</button
                    ><button type="button" class="danger-button" :disabled="saving || detail.task.busy || detail.task.status === 'paused'" @click="update(true)">Cancel future runs</button
                    ><button type="button" class="danger-button" :disabled="saving || detail.task.busy" @click="remove"><Trash2 :size="16" />Delete task</button>
                </div>
            </form>
            <section class="dialog-section">
                <h3>Activity</h3>
                <dl class="details">
                    <dt>Last run</dt>
                    <dd><DateLabel :value="detail.task.lastRunAt" /></dd>
                    <dt>Last successful run</dt>
                    <dd><DateLabel :value="detail.task.lastSuccessAt" /></dd>
                    <dt>Consecutive failures</dt>
                    <dd>{{ detail.task.consecutiveFailures }}</dd>
                    <dt>Last error</dt>
                    <dd>{{ detail.task.lastError || "None" }}</dd>
                </dl>
                <div class="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Started</th>
                                <th>Result</th>
                                <th>Added</th>
                                <th>Removed</th>
                                <th>Skipped</th>
                                <th>Conflicts</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="run in detail.runs" :key="run.id">
                                <td>
                                    <DateLabel :value="run.startedAt" /><span v-if="run.error" class="cell-secondary danger">{{ run.error }}</span>
                                </td>
                                <td>{{ run.status }}</td>
                                <td>{{ run.additions }}</td>
                                <td>{{ run.removals }}</td>
                                <td>{{ run.skipped }}</td>
                                <td>{{ run.conflicts }}</td>
                            </tr>
                            <tr v-if="!detail.runs.length">
                                <td colspan="6" class="empty">No retained runs.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </template>
    </dialog>
</template>
