<template>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
        <NuxtPage />
    </NuxtLayout>
</template>

<script setup lang="ts">
import type {SessionUser} from "~/types/api"

const config = useRuntimeConfig()
const route = useRoute()
const appName = String(config.public.appName)
const siteUrl = computed(() => String(config.public.siteUrl).replace(/\/$/, ""))
const canonicalUrl = computed(() => `${siteUrl.value}${route.path}`)

useHead({
    titleTemplate: (title) => (title ? `${appName} - ${title}` : appName)
})
useHead(() => ({
    link: [{rel: "canonical", href: canonicalUrl.value}]
}))
useSeoMeta({
    ogType: "website",
    ogSiteName: appName,
    ogTitle: appName,
    ogUrl: () => canonicalUrl.value,
    ogImage: () => `${siteUrl.value}/og-image.jpg`,
    twitterCard: "summary_large_image",
    twitterImage: () => `${siteUrl.value}/og-image.jpg`
})

const auth = useAuthStore()
const {data} = await useFetch<{user: SessionUser | null}>("/api/me")
auth.setUser(data.value?.user || null)
</script>
