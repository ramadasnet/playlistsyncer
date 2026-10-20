<script setup lang="ts">
// NuxtTime reformats before hydration, so the server and the browser locale/timezone never mismatch.
defineProps<{value?: string | Date | null}>()
</script>

<template>
    <NuxtTime v-if="value" :datetime="value" date-style="medium" time-style="short" />
    <template v-else>Not recorded</template>
</template>
