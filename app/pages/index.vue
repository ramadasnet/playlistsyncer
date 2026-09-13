<script setup lang="ts">
import {ArrowRight, Check, RefreshCw} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"

const {enabledProviders} = await useEnabledProviders()
const {everyLabel} = useProSyncCadence()

useSeoMeta({
    title: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `PlaylistSyncer - Sync ${names} playlists` : "PlaylistSyncer - Sync playlists"
    },
    description: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `Keep playlists aligned across ${names}, two-way or with a master playlist.` : "Keep playlists in sync across every music service."
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
            <p class="hero-copy">Keep your favorite tracks in sync, no matter which music provider you use! PlaylistSyncer allows you to automagically sync playlists across multiple platforms.</p>
            <div class="hero-actions">
                <NuxtLink class="button button-primary" :to="auth.user ? '/sync' : '/login'"> {{ auth.user ? "Open sync tasks" : "Register or login" }} <ArrowRight :size="18" /> </NuxtLink>
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
                <p class="eyebrow">As simple as it sounds</p>
                <h2>How it works</h2>
                <p>You can create one or multiple playlist sync tasks. .</p>
            </div>
            <ol class="workflow-steps">
                <li>
                    <span>01</span>
                    <div>
                        <strong>Connect</strong>
                        <p>Use the accounts you already trust to register or login to the service.</p>
                    </div>
                </li>
                <li>
                    <span>02</span>
                    <div>
                        <strong>Pair</strong>
                        <p>Select he playlists from the source and target providers, and whether they should sync one or two ways.</p>
                    </div>
                </li>
                <li>
                    <span>03</span>
                    <div>
                        <strong>Enjoy</strong>
                        <p>The playlists will sync and tracks will be added or removed as needed.</p>
                    </div>
                </li>
            </ol>
        </div>
    </section>

    <section class="proof-band">
        <div class="shell proof-grid">
            <article>
                <RefreshCw :size="26" />
                <h3>One-way or two-way</h3>
                <p>Choose whether each playlist pair should sync in one direction or both directions.</p>
            </article>
            <article>
                <Check :size="26" />
                <h3>No silent guesses</h3>
                <p>Ambiguous track matches and two-way conflicts are flagged for review, so you can decide what to do with them.</p>
            </article>
            <aside class="pro-callout">
                <p class="eyebrow light">And more!</p>
                <strong>PRO features</strong>
                <p>With a PRO account you can have unlimited playlist pairs getting synced {{ everyLabel }}, a full sync history, and a weekly summary with AI suggestions for new artists and tracks.</p>
                <NuxtLink to="/features">See plan details <ArrowRight :size="16" /></NuxtLink>
            </aside>
        </div>
    </section>
</template>
