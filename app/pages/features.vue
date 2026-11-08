<script setup lang="ts">
import {ArrowRight, Github, ShieldCheck} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"

usePageSeo({title: "Features", description: "Unlimited playlist sync, automatic scheduling, run history, and weekly summaries. Every PlaylistSyncer feature is completely free."})

const auth = useAuthStore()
const {enabledProviders} = await useEnabledProviders()
const {everyLabel} = useSyncCadence()
const features = computed(() => [
    {title: "Unlimited playlists", description: "Sync individual playlist pairs or all playlists between two music services."},
    {title: "Automatic sync", description: `Keep playlists aligned ${everyLabel.value}, without starting each run yourself.`},
    {title: "One-way or two-way", description: "Choose a master playlist or keep changes in sync in both directions."},
    {title: "Manual sync", description: "Start a sync whenever you need it, with no daily cooldown."},
    {title: "Run history", description: "Browse past runs and see added, removed, and unmatched tracks."},
    {title: "Weekly summaries", description: "Opt in to an email summary when tracks are added or removed."}
])
</script>

<template>
    <div class="shell page-shell">
        <PageHeading title="Features" description="Every feature is available to everyone, completely free." />

        <section class="features-section" aria-labelledby="features-title">
            <div class="section-intro compact">
                <p class="eyebrow">Everything included</p>
                <h2 id="features-title">Sync your whole library</h2>
            </div>
            <dl class="feature-list">
                <div v-for="feature in features" :key="feature.title">
                    <dt>{{ feature.title }}</dt>
                    <dd>{{ feature.description }}</dd>
                </div>
            </dl>
            <NuxtLink class="button button-primary" :to="auth.user ? '/sync' : '/login'">Start syncing <ArrowRight :size="17" /></NuxtLink>
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

        <section class="provider-support open-source">
            <div>
                <h2>Open source</h2>
                <p>PlaylistSyncer is fully open source. Prefer to run it on your own terms? <a href="https://github.com/ramadasnet/playlistsyncer" target="_blank" rel="noopener noreferrer">Download the code from GitHub</a> and host it yourself.</p>
            </div>
            <Github :size="44" aria-hidden="true" />
        </section>
    </div>
</template>
