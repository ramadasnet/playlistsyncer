<script setup lang="ts">
import {ArrowRight, Check, RefreshCw} from "lucide-vue-next"
import {formatProviderNames} from "~~/shared/types/domain"
import {complimentaryTrialEndsAt, formatTrialDate} from "~/utils/plan"

const config = useRuntimeConfig()
const {enabledProviders} = await useEnabledProviders()
const {everyLabel} = useProSyncCadence()
const {data: trial} = await useFetch<{proSubscriptionRequiredAt?: string}>("/api/trial")
const trialEndsAt = computed(() => complimentaryTrialEndsAt(trial.value?.proSubscriptionRequiredAt || String(config.public.proSubscriptionRequiredAt || "")))

usePageSeo({
    title: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `Sync ${names} playlists` : "Sync playlists"
    },
    description: () => {
        const names = formatProviderNames(enabledProviders.value)
        return names ? `Keep playlists aligned across ${names}, two-way or with a master playlist.` : "Keep playlists in sync across every music service."
    }
})

const siteUrl = String(config.public.siteUrl).replace(/\/$/, "")
useHead({
    script: [
        {
            type: "application/ld+json",
            innerHTML: JSON.stringify({
                "@context": "https://schema.org",
                "@type": "SoftwareApplication",
                name: String(config.public.appName),
                url: siteUrl,
                applicationCategory: "MultimediaApplication",
                operatingSystem: "Web",
                description: "Sync playlists one-way or two-way across music streaming providers."
            })
        }
    ]
})

const auth = useAuthStore()
</script>

<template>
    <section class="hero">
        <img src="/music-studio.jpg" alt="Visualization of playlists syncing across music providers" fetchpriority="high" />
        <div class="hero-scrim" />
        <div class="shell hero-content">
            <p class="eyebrow light">Cross-platform playlist sync</p>
            <h1>PlaylistSyncer</h1>
            <p class="hero-copy">Keep your favorite tracks in sync, no matter which music provider you use! PlaylistSyncer allows you to automagically sync playlists across multiple platforms.</p>
            <div class="hero-actions">
                <NuxtLink class="button button-primary" :to="auth.user ? '/sync' : '/login'"> {{ auth.user ? "Open sync tasks" : "Register or login" }} <ArrowRight :size="18" /> </NuxtLink>
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
                <p>
                    Start for free with a single playlist from one provider to another.<template v-if="trialEndsAt">
                        During our temporary promotion, getting a PRO account is free of charge until {{ formatTrialDate(trialEndsAt) }} — a subscription is only needed to keep PRO after that date.</template
                    ><template v-else> Upgrade to PRO to unlock unlimited and improved syncing.</template>
                </p>
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
                        <p>Select the playlists from the source and target providers, and whether the sync should be one-way or two-way.</p>
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
</template>
