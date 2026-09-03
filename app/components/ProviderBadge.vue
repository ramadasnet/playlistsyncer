<script setup lang="ts">
import {Music2, Play, Radio, Waves} from "lucide-vue-next"
import {providerDisplayNames, type Provider} from "~~/shared/types/domain"

defineProps<{provider: Provider; label?: string}>()
</script>

<template>
    <span class="provider-badge" :class="`provider-${provider}`">
        <Music2 v-if="provider === 'spotify'" :size="17" />
        <Radio v-else-if="provider === 'amazon'" :size="17" />
        <Play v-else-if="provider === 'youtube'" :size="17" fill="currentColor" />
        <Waves v-else :size="17" />
        {{ label || providerDisplayNames[provider] }}
    </span>
</template>
