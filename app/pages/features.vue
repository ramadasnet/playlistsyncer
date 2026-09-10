<script setup lang="ts">
import {ArrowRight, Check, RefreshCw, ShieldCheck} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"

const config = useRuntimeConfig()
const auth = useAuthStore()
const {enabledProviders} = await useEnabledProviders()
const features = [
    ["Playlist pairs", "1", "Unlimited"],
    ["Automatic cadence", "Weekly", "Every 12 hours"],
    ["Two-way or one-way sync", true, true],
    ["Manual sync", true, true],
    ["Run history and conflict visibility", true, true]
] as const
</script>

<template>
    <div class="shell page-shell">
        <PageHeading
            eyebrow="Plans and capabilities"
            title="Sync at the pace you listen"
            description="Start with one playlist pair, two-way or one-way. Go PRO when your library spans more services and moods."
        />

        <section class="plan-grid" aria-label="Account plans">
            <article class="plan-panel">
                <p class="eyebrow">Free</p>
                <h2>One essential pair</h2>
                <p class="price">€0 <span>forever</span></p>
                <p>Weekly background sync for the playlist you care about most, in either direction.</p>
                <NuxtLink class="button button-secondary" :to="auth.user ? '/sync' : '/login'"
                    >Start free <ArrowRight :size="17"
                /></NuxtLink>
            </article>
            <article class="plan-panel featured">
                <p class="eyebrow light">PRO</p>
                <h2>Your whole listening map</h2>
                <p class="price">{{ config.public.proPrice }}</p>
                <p>Unlimited pairs with synchronization every twelve hours.</p>
                <NuxtLink class="button button-light" :to="auth.user ? '/account' : '/login'"
                    >Choose PRO <ArrowRight :size="17"
                /></NuxtLink>
            </article>
        </section>

        <section class="mode-grid" aria-label="Sync directions">
            <article class="mode-panel">
                <RefreshCw :size="26" />
                <h2>Two-way</h2>
                <p>
                    Both playlists stay equal. Additions and removals on either service are compared with the last
                    successful baseline and copied to the other side.
                </p>
            </article>
            <article class="mode-panel">
                <ArrowRight :size="26" />
                <h2>One-way</h2>
                <p>
                    The first playlist you select is the master. The second playlist mirrors it: master changes are
                    copied over, and the master is never rewritten.
                </p>
            </article>
        </section>

        <section class="comparison" aria-labelledby="comparison-title">
            <div class="section-intro compact">
                <p class="eyebrow">Side by side</p>
                <h2 id="comparison-title">What each plan includes</h2>
            </div>
            <div class="comparison-table" role="table">
                <div class="comparison-row comparison-head" role="row">
                    <span>Capability</span><strong>Free</strong><strong>PRO</strong>
                </div>
                <div v-for="feature in features" :key="feature[0]" class="comparison-row" role="row">
                    <span>{{ feature[0] }}</span>
                    <span
                        ><Check v-if="feature[1] === true" :size="18" /><template v-else>{{
                            feature[1]
                        }}</template></span
                    >
                    <span
                        ><Check v-if="feature[2] === true" :size="18" /><template v-else>{{
                            feature[2]
                        }}</template></span
                    >
                </div>
            </div>
        </section>

        <section class="provider-support">
            <div>
                <p class="eyebrow">Provider support</p>
                <h2>Built on authorized connections</h2>
                <p v-if="enabledProviders.length">
                    {{ formatProviderNames(enabledProviders) }} use their official playlist APIs.
                </p>
            </div>
            <div v-if="enabledProviders.length" class="provider-stack">
                <ProviderBadge v-for="provider in enabledProviders" :key="provider" :provider="provider" />
            </div>
            <ShieldCheck :size="44" aria-hidden="true" />
        </section>
    </div>
</template>
