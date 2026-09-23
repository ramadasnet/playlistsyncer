<script setup lang="ts">
import {ArrowRight, Check, Minus, RefreshCw, ShieldCheck} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"
import {complimentaryTrialEndsAt, formatTrialDate} from "~/utils/plan"

const config = useRuntimeConfig()
const auth = useAuthStore()
const {enabledProviders} = await useEnabledProviders()
const {everyLabel, everyTitleLabel} = useProSyncCadence()
const {data: trial} = await useFetch<{proSubscriptionRequiredAt?: string}>("/api/trial")
const trialEndsAt = computed(() => complimentaryTrialEndsAt(trial.value?.proSubscriptionRequiredAt || String(config.public.proSubscriptionRequiredAt || "")))
type PlanValue = string | boolean
const features = computed<[string, PlanValue, PlanValue][]>(() => [
    ["Playlist pairs", "1", "Unlimited"],
    ["Automatic sync", "Weekly", everyTitleLabel.value],
    ["One-way sync", true, true],
    ["Two-way sync", true, true],
    ["Manual sync", true, true],
    ["Sync history", false, true],
    ["Weekly summaries", false, true]
])
</script>

<template>
    <div class="shell page-shell">
        <PageHeading title="Features" description="Start for free with a single playlist synced once a week. Go PRO to get all the tidbits." />

        <div v-if="trialEndsAt" class="notice" role="status">
            <span> Until {{ formatTrialDate(trialEndsAt) }}, every account includes complimentary PRO features. After that date, accounts without a valid subscription will revert to Free. </span>
        </div>

        <section class="plan-grid" aria-label="Account plans">
            <article class="plan-panel">
                <p class="eyebrow">Free</p>
                <h2>Sync one playlist</h2>
                <p class="price">0 EUR</p>
                <p>Weekly background sync for the playlist you care about most from one service to another.</p>
                <NuxtLink class="button button-secondary" :to="auth.user ? '/sync' : '/login'">Start free <ArrowRight :size="17" /></NuxtLink>
            </article>
            <article class="plan-panel featured">
                <p class="eyebrow light">PRO</p>
                <h2>Sync everything</h2>
                <p class="price">{{ config.public.proPrice }} / year</p>
                <p>Unlimited playlist with synchronization {{ everyLabel }}, sync history, weekly summaries, and more!</p>
                <NuxtLink class="button button-light" :to="auth.user ? '/account' : '/login'">Get PRO <ArrowRight :size="17" /></NuxtLink>
            </article>
        </section>

        <section class="comparison" aria-labelledby="comparison-title">
            <div class="section-intro compact">
                <p class="eyebrow">Side by side</p>
                <h2 id="comparison-title">Free vs. PRO</h2>
            </div>
            <div class="comparison-table" role="table">
                <div class="comparison-row comparison-head" role="row"><span></span><strong>Free</strong><strong>PRO</strong></div>
                <div v-for="feature in features" :key="feature[0]" class="comparison-row" role="row">
                    <span>{{ feature[0] }}</span>
                    <span>
                        <Check v-if="feature[1] === true" :size="18" aria-hidden="true" />
                        <Minus v-else-if="feature[1] === false" class="feature-absent" :size="18" aria-label="Not included" />
                        <template v-else>{{ feature[1] }}</template>
                    </span>
                    <span>
                        <Check v-if="feature[2] === true" :size="18" aria-hidden="true" />
                        <Minus v-else-if="feature[2] === false" class="feature-absent" :size="18" aria-label="Not included" />
                        <template v-else>{{ feature[2] }}</template>
                    </span>
                </div>
            </div>
        </section>

        <section class="provider-support">
            <div>
                <h2>Built on authorized connections</h2>
                <p v-if="enabledProviders.length">{{ formatProviderNames(enabledProviders) }} are integrated using their official APIs.<br />Need something else? <a href="mailto:info@playlistsyncer.com">Let us know!</a></p>
            </div>
            <div v-if="enabledProviders.length" class="provider-stack">
                <ProviderBadge v-for="provider in enabledProviders" :key="provider" :provider="provider" />
            </div>
            <ShieldCheck :size="44" aria-hidden="true" />
        </section>
    </div>
</template>
