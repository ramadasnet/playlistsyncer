<script setup lang="ts">
import {ArrowUpRight, CheckCircle2, CreditCard, Link2, LoaderCircle, Plus} from "lucide-vue-next"
import type {ConnectedAccount} from "~/types/api"
import type {Provider} from "~~/shared/types/domain"

definePageMeta({middleware: "auth"})

const auth = useAuthStore()
const {enabledProviders} = await useEnabledProviders()
const {data, refresh} = await useFetch<{accounts: ConnectedAccount[]}>("/api/accounts", {
    query: {includePlaylistCount: "true"}
})
const busy = ref(false)
const errorMessage = ref("")

async function openBilling(path: "checkout" | "portal") {
    busy.value = true
    errorMessage.value = ""
    try {
        const result = await $fetch<{url: string}>(`/api/billing/${path}`, {method: "POST"})
        await navigateTo(result.url, {external: true})
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : "Billing could not be opened"
    } finally {
        busy.value = false
    }
}

function hasProvider(provider: Provider) {
    return data.value?.accounts.some((account) => account.provider === provider)
}

function connectedAccount(provider: Provider) {
    return data.value?.accounts.find((account) => account.provider === provider)
}

onMounted(() => refresh())
</script>

<template>
    <div class="shell page-shell">
        <PageHeading
            eyebrow="Preferences"
            title="Account"
            description="Manage the identities, services, and plan behind your synchronization tasks."
        />

        <div v-if="errorMessage" class="notice notice-error" role="alert">{{ errorMessage }}</div>

        <section class="settings-section" aria-labelledby="profile-heading">
            <div class="settings-heading">
                <div>
                    <p class="eyebrow">Profile</p>
                    <h2 id="profile-heading">Your PlaylistSyncer account</h2>
                </div>
                <span
                    class="plan-badge"
                    :class="auth.user?.developmentProOverride ? 'plan-development' : `plan-${auth.user?.tier}`"
                    >{{ auth.user?.developmentProOverride ? "PRO / DEVELOPMENT" : auth.user?.tier }}</span
                >
            </div>
            <div class="profile-line">
                <img v-if="auth.user?.avatarUrl" :src="auth.user.avatarUrl" alt="" />
                <span v-else class="avatar-fallback">{{ auth.user?.displayName.slice(0, 1).toUpperCase() }}</span>
                <div>
                    <strong>{{ auth.user?.displayName }}</strong
                    ><span>{{ auth.user?.email }}</span>
                </div>
                <CheckCircle2 :size="20" class="success-icon" aria-label="Verified account" />
            </div>
        </section>

        <section class="settings-section" aria-labelledby="connections-heading">
            <div class="settings-heading">
                <div>
                    <p class="eyebrow">Music services</p>
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
                            ><span
                                >{{ connectedAccount(provider)?.playlistCount ?? 0 }}
                                {{ connectedAccount(provider)?.playlistCount === 1 ? "playlist" : "playlists" }}</span
                            >
                        </div>
                        <span class="status-dot"><span /> Connected</span>
                    </template>
                    <template v-else>
                        <div class="connection-copy">
                            <strong>Not connected</strong><span>Add this provider to use it in playlist pairs.</span>
                        </div>
                        <a
                            class="button button-small button-secondary"
                            :href="`/api/auth/${provider}?redirect=/account`"
                            ><Plus :size="16" /> Connect</a
                        >
                    </template>
                </div>
            </div>
        </section>

        <section class="settings-section billing-section" aria-labelledby="billing-heading">
            <div class="settings-heading">
                <div>
                    <p class="eyebrow">Subscription</p>
                    <h2 id="billing-heading">Plan and billing</h2>
                </div>
                <CreditCard :size="22" />
            </div>
            <div class="billing-copy">
                <div>
                    <strong>{{
                        auth.user?.developmentProOverride
                            ? "Development PRO access"
                            : auth.user?.tier === "pro"
                              ? "PRO plan"
                              : "Free plan"
                    }}</strong>
                    <p>
                        {{
                            auth.user?.developmentProOverride
                                ? "PRO features are enabled by a local development override. No paid subscription is active."
                                : auth.user?.tier === "pro"
                                  ? "Unlimited pairs · sync every 12 hours"
                                  : "One pair · sync every week"
                        }}
                    </p>
                </div>
                <button
                    v-if="auth.user?.tier === 'pro' && !auth.user.developmentProOverride"
                    class="button button-secondary"
                    type="button"
                    :disabled="busy"
                    @click="openBilling('portal')"
                >
                    Manage billing <ArrowUpRight :size="17" />
                </button>
                <button
                    v-else
                    class="button button-primary"
                    type="button"
                    :disabled="busy"
                    @click="openBilling('checkout')"
                >
                    <LoaderCircle v-if="busy" class="spin" :size="17" /> Upgrade to PRO
                </button>
            </div>
        </section>
    </div>
</template>
