<script setup lang="ts">
import {Music2, Play, Radio, Waves} from "lucide-vue-next"
import type {Provider} from "~~/shared/types/domain"

defineProps<{provider: Provider; label?: string}>()

const providerNames: Record<Provider, string> = {
    amazon: "Amazon Music",
    spotify: "Spotify",
    tidal: "TIDAL",
    youtube: "YouTube Music"
}
</script>

<template>
    <span class="provider-badge" :class="`provider-${provider}`">
        <Radio v-if="provider === 'amazon'" :size="17" />
        <Music2 v-else-if="provider === 'spotify'" :size="17" />
        <Waves v-else-if="provider === 'tidal'" :size="17" />
        <Play v-else :size="17" fill="currentColor" />
        {{ label || providerNames[provider] }}
    </span>
</template>
