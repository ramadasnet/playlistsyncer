<script setup lang="ts">
defineProps<{title: string; description: string}>()
</script>

<template>
    <header class="page-heading">
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
        <div v-if="$slots.actions" class="heading-actions"><slot name="actions" /></div>
    </header>
</template>
