<template>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
        <NuxtPage />
    </NuxtLayout>
</template>

<script setup lang="ts">
import type {SessionUser} from "~/types/api"

const auth = useAuthStore()
const {data} = await useFetch<{user: SessionUser | null}>("/api/me")
auth.setUser(data.value?.user || null)
</script>
