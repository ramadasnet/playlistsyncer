<script setup lang="ts">
defineProps<{eyebrow?: string; title: string; description: string}>()
</script>

<template>
    <header class="page-heading">
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
        <div v-if="$slots.actions" class="heading-actions"><slot name="actions" /></div>
    </header>
</template>
