<script setup lang="ts">
import {ArrowRight, Check, RefreshCw} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"

const {enabledProviders} = await useEnabledProviders()

useSeoMeta({
    title: "PlaylistSyncer · Two-way playlist syncing",
    description: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `Keep playlists aligned across ${names}.` : "Keep one listening life across every music service."
    }
})

const auth = useAuthStore()
</script>

<template>
    <section class="hero">
        <img src="/music-studio.jpg" alt="Mixing desk and instruments in a working music studio" />
        <div class="hero-scrim" />
        <div class="shell hero-content">
            <p class="eyebrow light">Cross-platform playlist sync</p>
            <h1>PlaylistSyncer</h1>
            <p class="hero-copy">
                Keep one listening life across every music service. Add a track here, remove it there, and your paired
                playlists settle the difference.
            </p>
            <div class="hero-actions">
                <NuxtLink class="button button-primary" :to="auth.user ? '/sync' : '/login'">
                    {{ auth.user ? "Open sync tasks" : "Connect a provider" }} <ArrowRight :size="18" />
                </NuxtLink>
                <NuxtLink class="button button-ghost-light" to="/features">Compare plans</NuxtLink>
            </div>
            <div v-if="enabledProviders.length" class="provider-row" aria-label="Supported providers">
                <ProviderBadge v-for="provider in enabledProviders" :key="provider" :provider="provider" />
            </div>
        </div>
    </section>

    <section class="workflow-band">
        <div class="shell workflow-grid">
            <div class="section-intro">
                <p class="eyebrow">A quieter way to move music</p>
                <h2>Choose a pair. Keep listening.</h2>
                <p>
                    PlaylistSyncer records a shared baseline, then carries deliberate additions and removals in both
                    directions.
                </p>
            </div>
            <ol class="workflow-steps">
                <li>
                    <span>01</span>
                    <div>
                        <strong>Connect</strong>
                        <p>Use the accounts you already trust.</p>
                    </div>
                </li>
                <li>
                    <span>02</span>
                    <div>
                        <strong>Pair</strong>
                        <p>Select the two playlists that should agree.</p>
                    </div>
                </li>
                <li>
                    <span>03</span>
                    <div>
                        <strong>Sync</strong>
                        <p>Run now or let the schedule take over.</p>
                    </div>
                </li>
            </ol>
        </div>
    </section>

    <section class="proof-band">
        <div class="shell proof-grid">
            <article>
                <RefreshCw :size="26" />
                <h3>Actually two-way</h3>
                <p>Changes from either service are compared against the last successful baseline.</p>
            </article>
            <article>
                <Check :size="26" />
                <h3>No silent guesses</h3>
                <p>Ambiguous track matches and contradictory edits are surfaced for review.</p>
            </article>
            <aside class="pro-callout">
                <p class="eyebrow light">PRO cadence</p>
                <strong>Twice a day</strong>
                <p>Unlimited playlist pairs, kept close without constant manual runs.</p>
                <NuxtLink to="/features">See plan details <ArrowRight :size="16" /></NuxtLink>
            </aside>
        </div>
    </section>
</template>
