<script setup lang="ts">
import {ArrowUpRight, CircleAlert, CreditCard, Link2, LoaderCircle, Mail, Plus, Trash2, Unlink} from "lucide-vue-next"
import type {ConnectedAccount, SessionUser} from "~/types/api"
import {providerDisplayNames, type Provider} from "~~/shared/types/domain"
import {complimentaryTrialEndsAt, formatTrialDate, planBadgeClass, planBadgeLabel} from "~/utils/plan"
import {maxDisplayNameLength, normalizeDisplayName} from "~~/shared/display-name"

definePageMeta({middleware: "auth"})
useSeoMeta({title: "Account"})

const auth = useAuthStore()
const route = useRoute()
const runtimeConfig = useRuntimeConfig()
const {everyLabel} = useProSyncCadence()
const {enabledProviders} = await useEnabledProviders()
const {data, refresh} = await useFetch<{accounts: ConnectedAccount[]}>("/api/accounts", {
    query: {includePlaylistCount: "true"}
})
const busy = ref(false)
const emailBusy = ref(false)
const emailCancelBusy = ref(false)
const preferenceBusy = ref(false)
const displayNameBusy = ref(false)
const showEmailDialog = ref(false)
const editingDisplayName = ref(false)
const errorMessage = ref("")
const emailError = ref("")
const displayNameError = ref("")
const successMessage = ref(route.query.email === "confirmed" ? "Your email address is confirmed." : "")
const emailInput = ref(auth.user?.tempEmail || "")
const devConfirmationUrl = ref("")
const emailDialogTitle = computed(() => (auth.user?.email ? "Change email address" : "Add email address"))
const emailDialogAction = computed(() => (auth.user?.email ? "Change email" : "Add email"))
const displayNameInput = ref("")
const displayNameField = useTemplateRef<HTMLInputElement>("displayNameField")
const normalizedDisplayName = computed(() => normalizeDisplayName(displayNameInput.value))
const disconnectTarget = ref<ConnectedAccount | null>(null)
const showDisconnectDialog = ref(false)
const disconnectBusy = ref(false)
const disconnectError = ref("")
const showDeleteDialog = ref(false)
const deleteBusy = ref(false)
const deleteError = ref("")

const needsEmail = computed(() => Boolean(auth.user) && !auth.user?.email && !auth.user?.tempEmail)
const pendingEmail = computed(() => Boolean(auth.user?.tempEmail))
const isCurrentConfirmedEmail = computed(() => Boolean(auth.user?.email && emailInput.value.trim().toLowerCase() === auth.user.email))
const canEditWeeklySummary = computed(() => auth.user?.tier === "pro" && Boolean(auth.user.email))
const isPaidPro = computed(() => Boolean(auth.user?.tier === "pro" && !auth.user.developmentProOverride && !auth.user.trialAccess))
const trialEndsAt = computed(() => complimentaryTrialEndsAt(auth.user?.proSubscriptionRequiredAt || String(runtimeConfig.public.proSubscriptionRequiredAt || "")))
const billingCopy = computed(() => {
    if (!auth.user?.email) {
        return "Confirm an email address before upgrading."
    }
    if (auth.user.developmentProOverride) {
        return "PRO features are enabled by a local development override. No paid subscription is active."
    }
    if (auth.user.trialAccess && trialEndsAt.value) {
        return `PRO features are complimentary until ${formatTrialDate(trialEndsAt.value)} while PlaylistSyncer is being tested. Subscribe to keep them afterward.`
    }
    if (auth.user.tier === "pro") {
        return `Unlimited pairs · sync ${everyLabel.value} · run history`
    }
    return "One pair · sync every week"
})
const billingTitle = computed(() => {
    if (auth.user?.developmentProOverride) {
        return "Development PRO access"
    }
    if (auth.user?.trialAccess) {
        return "Complimentary PRO trial"
    }
    return auth.user?.tier === "pro" ? "PRO plan" : "Free plan"
})
const resendSameEmail = computed(() => pendingEmail.value && emailInput.value.trim().toLowerCase() === auth.user?.tempEmail)

watch(
    () => data.value?.accounts,
    (accounts) => {
        if (emailInput.value || auth.user?.email) {
            return
        }
        const fromProvider = accounts?.find((account) => account.email)?.email
        if (fromProvider) {
            emailInput.value = fromProvider
        }
    },
    {immediate: true}
)

function statusMessage(error: unknown, fallback: string): string {
    if (error && typeof error === "object" && "data" in error) {
        const data = (error as {data?: {statusMessage?: string}}).data
        if (data?.statusMessage) {
            return data.statusMessage
        }
    }
    if (error instanceof Error && error.message) {
        return error.message
    }
    return fallback
}

async function openBilling(path: "checkout" | "portal") {
    busy.value = true
    errorMessage.value = ""
    try {
        const result = await api<{url: string}>(`/api/billing/${path}`, {method: "POST"})
        await navigateTo(result.url, {external: true})
    } catch (error) {
        errorMessage.value = statusMessage(error, "Billing could not be opened")
    } finally {
        busy.value = false
    }
}

async function setWeeklySyncSummary(enabled: boolean) {
    if (!canEditWeeklySummary.value || preferenceBusy.value || auth.user?.weeklySyncSummaryEnabled === enabled) {
        return
    }
    preferenceBusy.value = true
    errorMessage.value = ""
    try {
        const result = await api<{user: SessionUser}>("/api/me/preferences", {
            method: "PATCH",
            body: {weeklySyncSummaryEnabled: enabled}
        })
        auth.setUser(result.user)
        successMessage.value = enabled ? "Weekly sync summaries are on. You will get an email when tracks are added or removed." : "Weekly sync summaries are off."
    } catch (error) {
        errorMessage.value = statusMessage(error, "The weekly summary preference could not be saved")
    } finally {
        preferenceBusy.value = false
    }
}

// Swap the name for a focused text field with the current value selected.
async function startDisplayNameEdit() {
    if (editingDisplayName.value || displayNameBusy.value) {
        return
    }
    displayNameInput.value = auth.user?.displayName || ""
    displayNameError.value = ""
    editingDisplayName.value = true
    await nextTick()
    displayNameField.value?.focus()
    displayNameField.value?.select()
}

function cancelDisplayNameEdit() {
    editingDisplayName.value = false
    displayNameError.value = ""
}

// Leaving the field saves the change, except for an empty value which restores the name.
function onDisplayNameBlur() {
    if (!normalizedDisplayName.value) {
        cancelDisplayNameEdit()
        return
    }
    saveDisplayName()
}

async function saveDisplayName() {
    if (!editingDisplayName.value || displayNameBusy.value) {
        return
    }
    if (normalizedDisplayName.value === auth.user?.displayName) {
        cancelDisplayNameEdit()
        return
    }
    if (!normalizedDisplayName.value) {
        displayNameError.value = "Display name is required"
        return
    }
    if (normalizedDisplayName.value.length > maxDisplayNameLength) {
        displayNameError.value = `Display name must be ${maxDisplayNameLength} characters or fewer`
        return
    }
    displayNameBusy.value = true
    displayNameError.value = ""
    errorMessage.value = ""
    successMessage.value = ""
    devConfirmationUrl.value = ""
    try {
        const result = await api<{user: SessionUser}>("/api/me/profile", {
            method: "PATCH",
            body: {displayName: normalizedDisplayName.value}
        })
        auth.setUser(result.user)
        editingDisplayName.value = false
        successMessage.value = "Your display name was updated."
    } catch (error) {
        displayNameError.value = statusMessage(error, "The display name could not be saved")
    } finally {
        displayNameBusy.value = false
    }
    if (editingDisplayName.value) {
        await nextTick()
        displayNameField.value?.focus()
    }
}

// Prefill the dialog with a pending address so a confirmation can be resent.
function openEmailDialog() {
    emailInput.value = auth.user?.tempEmail || ""
    emailError.value = ""
    showEmailDialog.value = true
}

async function saveEmail() {
    emailBusy.value = true
    emailError.value = ""
    errorMessage.value = ""
    successMessage.value = ""
    devConfirmationUrl.value = ""
    try {
        const result = await api<{
            user: SessionUser
            sent: boolean
            devConfirmationUrl?: string
        }>("/api/me/email", {
            method: "POST",
            body: {email: emailInput.value}
        })
        const hadConfirmedEmail = Boolean(auth.user?.email)
        auth.setUser(result.user)
        emailInput.value = result.user.tempEmail || emailInput.value
        devConfirmationUrl.value = result.devConfirmationUrl || ""
        showEmailDialog.value = false
        successMessage.value = result.sent
            ? hadConfirmedEmail
                ? "Confirmation email sent. Check your inbox to finish changing your email address."
                : "Confirmation email sent. Check your inbox to finish setting your email address."
            : "Email saved. Confirm it from the link we sent, or use the development link if mail is not configured."
    } catch (error) {
        emailError.value = statusMessage(error, "The email address could not be saved")
    } finally {
        emailBusy.value = false
    }
}

// Drop the pending address and invalidate its confirmation token.
async function cancelPendingEmailChange() {
    if (!auth.user?.tempEmail || emailCancelBusy.value) {
        return
    }
    emailCancelBusy.value = true
    errorMessage.value = ""
    successMessage.value = ""
    devConfirmationUrl.value = ""
    try {
        const result = await api<{user: SessionUser}>("/api/me/email/pending", {method: "DELETE"})
        auth.setUser(result.user)
        emailInput.value = ""
        showEmailDialog.value = false
        successMessage.value = result.user.email ? "The email change was canceled. Your current address is unchanged." : "The pending email confirmation was canceled."
    } catch (error) {
        errorMessage.value = statusMessage(error, "The pending email confirmation could not be canceled")
    } finally {
        emailCancelBusy.value = false
    }
}

function hasProvider(provider: Provider) {
    return data.value?.accounts.some((account) => account.provider === provider)
}

function connectedAccount(provider: Provider) {
    return data.value?.accounts.find((account) => account.provider === provider)
}

function openDisconnectDialog(account: ConnectedAccount) {
    disconnectTarget.value = account
    disconnectError.value = ""
    showDisconnectDialog.value = true
}

// Delete the stored provider access; the server refuses while a sync task still uses the account.
async function confirmDisconnect() {
    const account = disconnectTarget.value
    if (!account || disconnectBusy.value) {
        return
    }
    disconnectBusy.value = true
    disconnectError.value = ""
    errorMessage.value = ""
    successMessage.value = ""
    try {
        await api(`/api/accounts/${account.id}`, {method: "DELETE"})
        await refresh()
        showDisconnectDialog.value = false
        successMessage.value = `${providerDisplayNames[account.provider]} was disconnected.`
    } catch (error) {
        disconnectError.value = statusMessage(error, "The account could not be disconnected")
    } finally {
        disconnectBusy.value = false
    }
}

function openDeleteDialog() {
    deleteError.value = ""
    showDeleteDialog.value = true
}

async function confirmDeleteAccount() {
    if (deleteBusy.value) {
        return
    }
    deleteBusy.value = true
    deleteError.value = ""
    try {
        await api("/api/me", {method: "DELETE"})
        showDeleteDialog.value = false
        auth.setUser(null)
        await navigateTo("/")
    } catch (error) {
        deleteError.value = statusMessage(error, "Your account could not be deleted")
    } finally {
        deleteBusy.value = false
    }
}

onMounted(() => refresh())
</script>

<template>
    <div class="shell page-shell">
        <PageHeading title="Account" description="Manage your music provider connections and account preferences." />

        <div v-if="needsEmail" class="notice" role="status">Your music service did not share an email address. Add one to finish setting up your account.</div>
        <div v-else-if="pendingEmail" class="notice" role="status">
            Confirm {{ auth.user?.tempEmail }} from the link we sent.{{ auth.user?.email ? " Your current address stays active until then." : " You can send another confirmation from Add email." }}
        </div>
        <div v-if="successMessage" class="notice notice-success" role="status">
            <span>{{ successMessage }}</span>
            <a v-if="devConfirmationUrl" :href="devConfirmationUrl">Confirm email (dev)</a>
        </div>
        <div v-if="errorMessage" class="notice notice-error" role="alert">{{ errorMessage }}</div>

        <section class="settings-section" aria-labelledby="profile-heading">
            <div class="settings-heading">
                <div>
                    <h2 id="profile-heading">My Details</h2>
                </div>
                <span class="plan-badge" :class="auth.user ? planBadgeClass(auth.user) : 'plan-free'">{{ auth.user ? planBadgeLabel(auth.user) : "" }}</span>
            </div>
            <div class="profile-line">
                <img v-if="auth.user?.avatarUrl" :src="auth.user.avatarUrl" alt="" />
                <span v-else class="avatar-fallback">{{ auth.user?.displayName.slice(0, 1).toUpperCase() }}</span>
                <div>
                    <form v-if="editingDisplayName" class="display-name-form" @submit.prevent="saveDisplayName">
                        <input
                            ref="displayNameField"
                            v-model="displayNameInput"
                            class="display-name-input"
                            type="text"
                            name="displayName"
                            autocomplete="nickname"
                            aria-label="Display name"
                            required
                            :maxlength="maxDisplayNameLength"
                            :aria-invalid="Boolean(displayNameError)"
                            :aria-describedby="displayNameError ? 'display-name-error' : undefined"
                            :readonly="displayNameBusy"
                            @keydown.esc.prevent="cancelDisplayNameEdit"
                            @blur="onDisplayNameBlur"
                        />
                        <LoaderCircle v-if="displayNameBusy" class="spin" :size="16" />
                    </form>
                    <button v-else class="display-name-trigger" type="button" :title="`Click to edit (max ${maxDisplayNameLength} characters)`" :aria-label="`Edit display name ${auth.user?.displayName || ''}`" @click="startDisplayNameEdit">
                        {{ auth.user?.displayName }}
                    </button>
                    <span v-if="displayNameError" id="display-name-error" class="display-name-error" role="alert">{{ displayNameError }}</span>
                    <span v-if="auth.user?.email">{{ auth.user.email }}</span>
                    <span v-else-if="!auth.user?.tempEmail">No email address yet</span>
                    <span v-if="auth.user?.tempEmail" class="pending-email">
                        Pending confirmation: {{ auth.user.tempEmail }}
                        <button type="button" class="pending-email-cancel" :disabled="emailCancelBusy" :aria-label="`Cancel pending confirmation of ${auth.user.tempEmail}`" @click="cancelPendingEmailChange">
                            {{ emailCancelBusy ? "Canceling…" : "Cancel" }}
                        </button>
                    </span>
                </div>
                <div class="profile-actions">
                    <CircleAlert v-if="!auth.user?.email" class="warning-icon" aria-label="Email address pending confirmation" />
                    <button class="button button-small button-secondary" type="button" aria-haspopup="dialog" :aria-expanded="showEmailDialog" @click="openEmailDialog">{{ emailDialogAction }}</button>
                </div>
            </div>
        </section>

        <OverlayDialog v-model="showEmailDialog" :title="emailDialogTitle" :busy="emailBusy">
            <p>{{ auth.user?.email ? "Enter your new email address below." : "Enter an email address that we can use to contact you." }}</p>
            <p v-if="emailError" class="dialog-error" role="alert">{{ emailError }}</p>
            <form class="email-capture" @submit.prevent="saveEmail">
                <label>
                    <span>{{ pendingEmail ? "Email address to confirm" : auth.user?.email ? "New email address" : "Email address" }}</span>
                    <input v-model="emailInput" type="email" name="email" autocomplete="email" required autofocus :disabled="emailBusy" />
                </label>
                <button class="button button-primary" type="submit" :disabled="emailBusy || !emailInput.trim() || isCurrentConfirmedEmail">
                    <LoaderCircle v-if="emailBusy" class="spin" :size="17" />
                    {{ resendSameEmail ? "Resend confirmation" : "Confirm email" }}
                </button>
            </form>
        </OverlayDialog>

        <section class="settings-section" aria-labelledby="connections-heading">
            <div class="settings-heading">
                <div>
                    <h2 id="connections-heading">Connected accounts</h2>
                </div>
                <Link2 :size="22" />
            </div>
            <div class="connection-list">
                <div v-for="provider in enabledProviders" :key="provider" class="connection-row">
                    <ProviderBadge :provider="provider" />
                    <template v-if="hasProvider(provider)">
                        <div class="connection-copy">
                            <strong>{{ connectedAccount(provider)?.displayName }}</strong
                            ><span>{{ connectedAccount(provider)?.email || "Connected" }}</span
                            ><span>{{ connectedAccount(provider)?.playlistCount ?? 0 }} {{ connectedAccount(provider)?.playlistCount === 1 ? "playlist" : "playlists" }}</span>
                        </div>
                        <div class="connection-actions">
                            <span class="status-dot"><span /> Connected</span>
                            <button class="button button-small button-secondary" type="button" aria-haspopup="dialog" :aria-label="`Disconnect ${providerDisplayNames[provider]}`" @click="openDisconnectDialog(connectedAccount(provider)!)">
                                <Unlink :size="16" /> Disconnect
                            </button>
                        </div>
                    </template>
                    <template v-else>
                        <div class="connection-copy"><strong>Not connected</strong><span>Add this provider to use it in playlist pairs.</span></div>
                        <a class="button button-small button-secondary" :href="`/api/auth/${provider}?redirect=/account`"><Plus :size="16" /> Connect</a>
                    </template>
                </div>
            </div>
        </section>

        <OverlayDialog v-model="showDisconnectDialog" :title="`Disconnect ${disconnectTarget ? providerDisplayNames[disconnectTarget.provider] : ''}`" :busy="disconnectBusy">
            <p v-if="disconnectTarget" class="confirm-dialog-copy">
                PlaylistSyncer deletes its access to <strong>{{ disconnectTarget.displayName }}</strong
                >. Your playlists on {{ providerDisplayNames[disconnectTarget.provider] }} stay as they are, and you can connect again at any time.
            </p>
            <p v-if="disconnectError" class="dialog-error" role="alert">{{ disconnectError }}</p>
            <div class="dialog-actions">
                <button class="button button-secondary" type="button" :disabled="disconnectBusy" @click="showDisconnectDialog = false">Cancel</button>
                <button class="button button-danger" type="button" :disabled="disconnectBusy" @click="confirmDisconnect">
                    <LoaderCircle v-if="disconnectBusy" class="spin" :size="17" />
                    Disconnect
                </button>
            </div>
        </OverlayDialog>

        <section class="settings-section" aria-labelledby="notifications-heading">
            <div class="settings-heading">
                <div>
                    <h2 id="notifications-heading">Notifications</h2>
                </div>
                <Mail :size="22" />
            </div>
            <div class="preference-row">
                <div>
                    <p>
                        {{ auth.user?.email ? "Get a weekly summary of playlist updates via email." : "Set your email address first before enabling the weekly summary." }}
                        <span v-if="auth.user?.tier != 'pro'">(PRO only)</span>
                    </p>
                </div>
                <button
                    class="switch"
                    type="button"
                    role="switch"
                    :aria-checked="Boolean(auth.user?.weeklySyncSummaryEnabled)"
                    :aria-label="auth.user?.weeklySyncSummaryEnabled ? 'Disable weekly sync summary' : 'Enable weekly sync summary'"
                    :disabled="preferenceBusy || !canEditWeeklySummary"
                    @click="setWeeklySyncSummary(!auth.user?.weeklySyncSummaryEnabled)"
                >
                    <LoaderCircle v-if="preferenceBusy" class="spin" :size="16" />
                    <span v-else />
                </button>
            </div>
        </section>

        <section class="settings-section billing-section" aria-labelledby="billing-heading">
            <div class="settings-heading">
                <div>
                    <h2 id="billing-heading">Subscription</h2>
                </div>
                <CreditCard :size="22" />
            </div>
            <div class="billing-copy">
                <div>
                    <strong>{{ billingTitle }}</strong>
                    <p>{{ billingCopy }}</p>
                </div>
                <button v-if="isPaidPro" class="button button-secondary" type="button" :disabled="busy" @click="openBilling('portal')">Manage billing <ArrowUpRight :size="17" /></button>
                <button v-else class="button button-primary" type="button" :disabled="busy || !auth.user?.email" @click="openBilling('checkout')">
                    <LoaderCircle v-if="busy" class="spin" :size="17" />
                    {{ auth.user?.trialAccess ? "Keep PRO" : "Upgrade to PRO" }}
                </button>
            </div>
        </section>

        <section class="settings-section" aria-labelledby="delete-account-heading">
            <div class="settings-heading">
                <div>
                    <h2 id="delete-account-heading">Delete account</h2>
                </div>
                <Trash2 :size="22" />
            </div>
            <div class="billing-copy">
                <p>Permanently delete your PlaylistSyncer account, sync tasks, run history, and access to your music services.</p>
                <button class="button button-danger" type="button" aria-haspopup="dialog" @click="openDeleteDialog">Delete account</button>
            </div>
        </section>

        <OverlayDialog v-model="showDeleteDialog" title="Delete account" :busy="deleteBusy">
            <p class="confirm-dialog-copy">This permanently deletes your account and everything PlaylistSyncer stores for it. Playlists on your music services stay as they are. This cannot be undone.</p>
            <p v-if="deleteError" class="dialog-error" role="alert">{{ deleteError }}</p>
            <div class="dialog-actions">
                <button class="button button-secondary" type="button" :disabled="deleteBusy" @click="showDeleteDialog = false">Cancel</button>
                <button class="button button-danger" type="button" :disabled="deleteBusy" @click="confirmDeleteAccount">
                    <LoaderCircle v-if="deleteBusy" class="spin" :size="17" />
                    Delete account
                </button>
            </div>
        </OverlayDialog>
    </div>
</template>
