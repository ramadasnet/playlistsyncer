<script setup lang="ts">
const config = useRuntimeConfig()

useSeoMeta({
    title: "Support",
    description: "Chat with PlaylistSyncer support or email us if you need a human follow-up."
})
</script>

<template>
    <div class="shell page-shell support-page">
        <PageHeading title="Support" description="Chat with PlaylistSyncer support or email us if you need a human follow-up." />
        <iframe class="support-frame" :src="config.public.chatbaseHelpUrl" title="PlaylistSyncer support chat" loading="eager" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write" />
    </div>
</template>
