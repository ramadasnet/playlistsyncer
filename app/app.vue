<template>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
        <NuxtPage />
    </NuxtLayout>
</template>

<script setup lang="ts">
import type {SessionUser} from "~/types/api"

useHead({
    titleTemplate: (title) => (title ? `PlaylistSyncer - ${title}` : "PlaylistSyncer")
})

const auth = useAuthStore()
const {data} = await useFetch<{user: SessionUser | null}>("/api/me")
auth.setUser(data.value?.user || null)
</script>
