<script setup lang="ts">
import {ArrowRight, Check, RefreshCw} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"

const {enabledProviders} = await useEnabledProviders()

useSeoMeta({
    title: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `PlaylistSyncer - Sync ${names} playlists` : "PlaylistSyncer - Sync playlists"
    },
    description: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `Keep playlists aligned across ${names}, two-way or with a master playlist.` : "Keep one listening life across every music service."
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
            <p class="hero-copy">Keep one listening life across every music service. Sync two playlists so they stay equal, or make the first playlist the master and let the second mirror it.</p>
            <div class="hero-actions">
                <NuxtLink class="button button-primary" :to="auth.user ? '/sync' : '/login'"> {{ auth.user ? "Open sync tasks" : "Connect a provider" }} <ArrowRight :size="18" /> </NuxtLink>
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
                <p>PlaylistSyncer can keep a pair in agreement both ways, or copy one playlist onto another. Choose the direction when you create the task.</p>
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
                        <p>Select two playlists and whether they should agree both ways or follow a master.</p>
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
                <h3>Two-way or one-way</h3>
                <p>Keep both playlists equal, or treat the first playlist as the master and mirror it onto the second.</p>
            </article>
            <article>
                <Check :size="26" />
                <h3>No silent guesses</h3>
                <p>Ambiguous track matches and two-way conflicts are surfaced for review instead of being guessed.</p>
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
