<script setup lang="ts">
import {ArrowLeft, ArrowRight, ExternalLink, RefreshCw, Save, Search, X} from "lucide-vue-next"
import type {UserDetail, UserList} from "../../shared/contracts"
import {errorLabel} from "../utils/format"

const props = defineProps<{subscriptions?: boolean}>()
const route = useRoute()
const search = ref("")
const appliedSearch = ref("")
const filter = ref("")
const provider = ref(typeof route.query.provider === "string" ? route.query.provider : "")
const page = ref(1)
const query = computed(() => ({page: page.value, search: appliedSearch.value, status: filter.value, ...(provider.value ? {provider: provider.value} : {})}))
const {data, status, error, refresh} = await useFetch<UserList>("/api/users", {query})
const detail = ref<UserDetail | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const loading = ref("")
const saving = ref(false)
const failure = ref("")
const notice = ref("")
const form = reactive({displayName: "", email: "", weeklySyncSummaryEnabled: false})
const billingAction = ref("reconcile")

watch([filter, provider], () => {
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
        billingAction.value = "reconcile"
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
async function billing() {
    if (!detail.value) return
    if (billingAction.value !== "reconcile" && !window.confirm(`Apply ${billingAction.value} to this subscription in Creem? This changes billing and access.`)) return
    saving.value = true
    failure.value = ""
    notice.value = ""
    try {
        fill(await $fetch<UserDetail>(`/api/users/${detail.value.user.id}/subscription`, {method: "POST", body: {action: billingAction.value}}))
        notice.value = "Subscription synchronized with Creem."
        await refresh()
    } catch (cause) {
        failure.value = `${errorLabel(cause)} Reconcile with Creem before retrying a billing change.`
    } finally {
        saving.value = false
    }
}
async function discover() {
    if (!window.confirm("Read all subscriptions from Creem and reconcile local account access?")) return
    saving.value = true
    failure.value = ""
    notice.value = ""
    try {
        const result = await $fetch<{checked: number; updated: number; failed: number; unmatched: number}>("/api/subscriptions/discover", {method: "POST"})
        notice.value = `Creem: ${result.checked} checked, ${result.updated} updated, ${result.unmatched} unmatched, ${result.failed} failed.`
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
            <p class="eyebrow">{{ subscriptions ? "BILLING" : "ACCOUNTS" }}</p>
            <h1>{{ subscriptions ? "Subscriptions" : "Users" }}</h1>
            <p class="muted">{{ data?.total.toLocaleString() ?? "..." }} matching accounts</p>
        </div>
        <div class="actions">
            <button v-if="subscriptions" :disabled="saving" @click="discover"><RefreshCw :size="16" />Discover & reconcile</button
            ><button class="icon-button" title="Refresh accounts" aria-label="Refresh accounts" :disabled="status === 'pending'" @click="refresh()"><RefreshCw :size="18" /></button>
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
        <select v-model="filter" aria-label="Filter plan or billing status">
            <option value="">All plans & statuses</option>
            <option value="pro">Stored PRO</option>
            <option value="free">Stored Free</option>
            <option v-for="state in ['active', 'trialing', 'scheduled_cancel', 'paused', 'canceled', 'past_due', 'unpaid', 'expired']" :key="state" :value="state">{{ state }}</option></select
        ><select v-model="provider" aria-label="Filter music provider">
            <option value="">All music providers</option>
            <option v-for="name in ['spotify', 'tidal', 'youtube', 'soundcloud', 'amazon']" :key="name" :value="name">{{ name }}</option>
        </select>
    </form>
    <p v-if="status === 'pending'" class="muted" role="status">Loading accounts...</p>
    <div class="table-scroll">
        <table>
            <thead>
                <tr>
                    <th>User</th>
                    <th>{{ subscriptions ? "Creem status" : "Providers" }}</th>
                    <th>Access</th>
                    <th>{{ subscriptions ? "Next payment" : "Last login" }}</th>
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
                        <span v-if="subscriptions" class="badge" :class="user.subscriptionStatus">{{ user.subscriptionStatus || "No subscription" }}</span>
                        <div v-else class="provider-tags">
                            <span v-for="name in user.providers" :key="name" class="provider-tag"><i class="provider-dot" :class="name"></i>{{ name }}</span>
                        </div>
                    </td>
                    <td>
                        <span class="badge" :class="user.effectiveTier">{{ user.effectiveTier.toUpperCase() }}</span>
                    </td>
                    <td><DateLabel :value="subscriptions ? user.nextPaymentAt : user.lastLoginAt" /></td>
                    <td>
                        <button :disabled="!!loading" @click="open(user.id)">{{ loading === user.id ? "Loading..." : "Manage" }}<ExternalLink :size="14" /></button>
                    </td>
                </tr>
                <tr v-if="data && !data.items.length">
                    <td colspan="5" class="empty">No matching accounts.</td>
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
                ><label class="checkbox-label"><input v-model="form.weeklySyncSummaryEnabled" type="checkbox" :disabled="detail.user.effectiveTier !== 'pro'" />Weekly sync summary</label
                ><button class="primary" :disabled="saving"><Save :size="16" />Save user</button>
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
                <h3>Subscription</h3>
                <dl class="details">
                    <dt>Status</dt>
                    <dd>{{ detail.user.subscriptionStatus || "No subscription" }}</dd>
                    <dt>Effective / stored tier</dt>
                    <dd>{{ detail.user.effectiveTier }} / {{ detail.user.tier }}</dd>
                    <dt>Subscription ID</dt>
                    <dd class="mono">{{ detail.user.subscriptionId || "None" }}</dd>
                    <dt>Customer ID</dt>
                    <dd class="mono">{{ detail.user.customerId || "None" }}</dd>
                    <dt>Last payment</dt>
                    <dd><DateLabel :value="detail.user.lastPaymentAt" /></dd>
                    <dt>Next payment</dt>
                    <dd><DateLabel :value="detail.user.nextPaymentAt" /></dd>
                    <dt>Period start</dt>
                    <dd><DateLabel :value="detail.user.periodStart" /></dd>
                    <dt>Period end</dt>
                    <dd><DateLabel :value="detail.user.periodEnd" /></dd>
                    <dt>Canceled</dt>
                    <dd><DateLabel :value="detail.user.canceledAt" /></dd>
                    <dt>Creem updated</dt>
                    <dd><DateLabel :value="detail.user.subscriptionUpdatedAt" /></dd>
                </dl>
                <form v-if="detail.user.subscriptionId" class="billing-controls" @submit.prevent="billing">
                    <label
                        >Billing action<select v-model="billingAction">
                            <option value="reconcile">Reconcile from Creem</option>
                            <option v-if="detail.user.subscriptionStatus === 'active' || detail.user.subscriptionStatus === 'trialing'" value="pause">Pause subscription</option>
                            <option v-if="detail.user.subscriptionStatus === 'paused' || detail.user.subscriptionStatus === 'scheduled_cancel'" value="resume">Resume subscription</option>
                            <option v-if="!['canceled', 'expired'].includes(detail.user.subscriptionStatus || '')" value="cancel">Cancel at period end</option>
                            <option v-if="!['canceled', 'expired'].includes(detail.user.subscriptionStatus || '')" value="cancel-now">Cancel immediately</option>
                        </select></label
                    ><button :disabled="saving"><RefreshCw :size="16" />{{ saving ? "Working..." : "Apply in Creem" }}</button>
                </form>
            </section>
        </template>
    </dialog>
</template>
