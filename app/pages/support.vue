<script setup lang="ts">
const config = useRuntimeConfig()

useSeoMeta({
    title: "Support · PlaylistSyncer",
    description: "Chat with PlaylistSyncer support or email us if you need a human follow-up."
})
</script>

<template>
    <div class="shell page-shell support-page">
        <PageHeading
            eyebrow="Support"
            title="How can we help?"
            description="Ask the PlaylistSyncer assistant below. If you would rather email, write to us and we will follow up."
        />
        <p class="support-email">
            <a :href="`mailto:${config.public.supportEmail}`">{{ config.public.supportEmail }}</a>
        </p>
        <iframe
            class="support-frame"
            :src="config.public.chatbaseHelpUrl"
            title="PlaylistSyncer support chat"
            loading="eager"
            referrerpolicy="strict-origin-when-cross-origin"
            allow="clipboard-write"
        />
    </div>
</template>
