<script setup lang="ts">
import {ArrowLeft, ArrowRight, ExternalLink, RefreshCw, Save, Search, Trash2, X} from "lucide-vue-next"
import type {UserDetail, UserList} from "../../shared/contracts"
import {errorLabel} from "../utils/format"

const route = useRoute()
const search = ref("")
const appliedSearch = ref("")
const provider = ref(typeof route.query.provider === "string" ? route.query.provider : "")
const page = ref(1)
const query = computed(() => ({page: page.value, search: appliedSearch.value, ...(provider.value ? {provider: provider.value} : {})}))
const {data, status, error, refresh} = await useFetch<UserList>("/api/users", {query})
const detail = ref<UserDetail | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const loading = ref("")
const saving = ref(false)
const failure = ref("")
const notice = ref("")
const form = reactive({displayName: "", email: "", weeklySyncSummaryEnabled: false})

watch(provider, () => {
    page.value = 1
})
function searchUsers() {
    appliedSearch.value = search.value
    page.value = 1
}
function fill(result: UserDetail) {
    detail.value = result
    Object.assign(form, {displayName: result.user.displayName, email: result.user.email, weeklySyncSummaryEnabled: result.user.weeklySyncSummaryEnabled})
}
async function open(id: string) {
    loading.value = id
    failure.value = ""
    notice.value = ""
    try {
        fill(await $fetch<UserDetail>(`/api/users/${id}`))
        dialog.value?.showModal()
    } catch (cause) {
        failure.value = errorLabel(cause)
    } finally {
        loading.value = ""
    }
}
async function save() {
    if (!detail.value) return
    if (form.email !== detail.value.user.email && !window.confirm("Replace this user's confirmed email and revoke their active sessions?")) return
    saving.value = true
    failure.value = ""
    try {
        fill(await $fetch<UserDetail>(`/api/users/${detail.value.user.id}`, {method: "PATCH", body: {...form}}))
        notice.value = "User updated."
        await refresh()
    } catch (cause) {
        failure.value = errorLabel(cause)
    } finally {
        saving.value = false
    }
}
async function remove() {
    if (!detail.value) return
    if (!window.confirm("Permanently delete this user? Their account, provider connections, sessions, and all sync tasks and history will be erased. This cannot be undone.")) return
    saving.value = true
    failure.value = ""
    try {
        await $fetch(`/api/users/${detail.value.user.id}`, {method: "DELETE"})
        dialog.value?.close()
        detail.value = null
        notice.value = "User deleted."
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
            <p class="eyebrow">ACCOUNTS</p>
            <h1>Users</h1>
            <p class="muted">{{ data?.total.toLocaleString() ?? "..." }} matching accounts</p>
        </div>
        <div class="actions">
            <button class="icon-button" title="Refresh accounts" aria-label="Refresh accounts" :disabled="status === 'pending'" @click="refresh()"><RefreshCw :size="18" /></button>
        </div>
    </div>
    <p v-if="error || (failure && !dialog?.open)" role="alert" class="notice error">{{ error ? errorLabel(error) : failure }}</p>
    <p v-if="notice && !dialog?.open" role="status" class="notice">{{ notice }}</p>
    <form class="toolbar" @submit.prevent="searchUsers">
        <div class="search-field">
            <Search :size="18" /><input v-model="search" type="search" placeholder="Search name or email" aria-label="Search name or email" /><button class="icon-button" type="submit" title="Search" aria-label="Search">
                <ArrowRight :size="18" />
            </button>
        </div>
        <select v-model="provider" aria-label="Filter music provider">
            <option value="">All music providers</option>
            <option v-for="name in ['spotify', 'tidal', 'youtube', 'soundcloud', 'apple', 'amazon']" :key="name" :value="name">{{ name }}</option>
        </select>
    </form>
    <p v-if="status === 'pending'" class="muted" role="status">Loading accounts...</p>
    <div class="table-scroll">
        <table>
            <thead>
                <tr>
                    <th>User</th>
                    <th>Providers</th>
                    <th>Last login</th>
                    <th><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="user in data?.items" :key="user.id">
                    <td>
                        <strong>{{ user.displayName }}</strong
                        ><span class="cell-secondary">{{ user.email || "No confirmed email" }}</span>
                    </td>
                    <td>
                        <div class="provider-tags">
                            <span v-for="name in user.providers" :key="name" class="provider-tag"><i class="provider-dot" :class="name"></i>{{ name }}</span>
                        </div>
                    </td>
                    <td><DateLabel :value="user.lastLoginAt" /></td>
                    <td>
                        <button :disabled="!!loading" @click="open(user.id)">{{ loading === user.id ? "Loading..." : "Manage" }}<ExternalLink :size="14" /></button>
                    </td>
                </tr>
                <tr v-if="data && !data.items.length">
                    <td colspan="4" class="empty">No matching accounts.</td>
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
    <dialog ref="dialog" aria-labelledby="user-title" @cancel="saving && $event.preventDefault()">
        <template v-if="detail"
            ><div class="dialog-heading">
                <div>
                    <p class="eyebrow">ACCOUNT / {{ detail.user.id }}</p>
                    <h2 id="user-title">{{ detail.user.displayName }}</h2>
                </div>
                <button class="icon-button" title="Close account" aria-label="Close account" :disabled="saving" @click="dialog?.close()"><X :size="20" /></button>
            </div>
            <p v-if="failure" role="alert" class="notice error">{{ failure }}</p>
            <p v-if="notice" role="status" class="notice">{{ notice }}</p>
            <form class="edit-form" @submit.prevent="save">
                <label>Display name<input v-model="form.displayName" required maxlength="30" /></label><label>Confirmed email<input v-model="form.email" type="email" :required="Boolean(detail.user.email)" /></label
                ><label class="checkbox-label"><input v-model="form.weeklySyncSummaryEnabled" type="checkbox" :disabled="!form.email" />Weekly sync summary</label><button class="primary" :disabled="saving"><Save :size="16" />Save user</button>
            </form>
            <section class="dialog-section">
                <h3>Account details</h3>
                <dl class="details">
                    <dt>Created</dt>
                    <dd><DateLabel :value="detail.user.createdAt" /></dd>
                    <dt>Last login</dt>
                    <dd><DateLabel :value="detail.user.lastLoginAt" /></dd>
                    <dt>Pending email</dt>
                    <dd>{{ detail.user.pendingEmail || "None" }}</dd>
                    <dt>Connected accounts</dt>
                    <dd>
                        <span v-for="account in detail.accounts" :key="account.id" class="cell-secondary">{{ account.provider }} / {{ account.displayName }}</span
                        ><span v-if="!detail.accounts.length">None</span>
                    </dd>
                </dl>
                <NuxtLink class="text-link" :to="`/tasks?userId=${detail.user.id}`">View this user's sync tasks<ArrowRight :size="16" /></NuxtLink>
            </section>
            <section class="dialog-section">
                <h3>Danger zone</h3>
                <button type="button" class="danger-button" :disabled="saving" @click="remove"><Trash2 :size="16" />Delete user</button>
            </section>
        </template>
    </dialog>
</template>
