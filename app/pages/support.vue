<script setup lang="ts">
const config = useRuntimeConfig()
const helpUrl = computed(() => config.public.chatlabHelpUrl || "")
const supportEmail = computed(() => config.public.supportEmail || "")
const description = computed(() => {
    if (helpUrl.value) return "Chat with PlaylistSyncer support or email us if you need a human follow-up."
    if (supportEmail.value) return "Email PlaylistSyncer support if you need help."
    return "Find help for PlaylistSyncer."
})

useSeoMeta({
    title: "Support",
    description
})
</script>

<template>
    <div class="shell page-shell support-page">
        <PageHeading title="Support" :description="description" />
        <iframe v-if="helpUrl" class="support-frame" :src="helpUrl" title="PlaylistSyncer support chat" loading="eager" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write" />
        <p v-else-if="supportEmail" class="support-email">
            <a :href="`mailto:${supportEmail}`">{{ supportEmail }}</a>
        </p>
        <p v-else class="support-email">PlaylistSyncer is open source, please check our <a href="https://github.com/ramadasnet/playlistsyncer" target="_blank" rel="noopener noreferrer">GitHub</a> if you need support.</p>
    </div>
</template>
