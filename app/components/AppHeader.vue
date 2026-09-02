<script setup lang="ts">
import {LogOut, Menu, SlidersHorizontal, X} from "lucide-vue-next"

const auth = useAuthStore()
const open = ref(false)
const route = useRoute()

watch(
    () => route.fullPath,
    () => (open.value = false)
)
</script>

<template>
    <header class="site-header">
        <div class="shell header-inner">
            <NuxtLink class="brand" to="/" aria-label="PlaylistSyncer home">
                <span class="brand-record" aria-hidden="true"><span /></span>
                <span>PlaylistSyncer</span>
            </NuxtLink>

            <button
                class="icon-button nav-toggle"
                type="button"
                :aria-expanded="open"
                aria-label="Toggle navigation"
                @click="open = !open"
            >
                <X v-if="open" :size="20" />
                <Menu v-else :size="20" />
            </button>

            <nav class="primary-nav" :class="{open}" aria-label="Primary navigation">
                <NuxtLink to="/features">Features</NuxtLink>
                <template v-if="auth.user">
                    <NuxtLink to="/sync">Sync tasks</NuxtLink>
                    <NuxtLink to="/account">Account</NuxtLink>
                    <span
                        class="plan-badge"
                        :class="auth.user.developmentProOverride ? 'plan-development' : `plan-${auth.user.tier}`"
                        >{{ auth.user.developmentProOverride ? "PRO / DEV" : auth.user.tier }}</span
                    >
                    <button class="icon-button" type="button" title="Log out" aria-label="Log out" @click="auth.logout">
                        <LogOut :size="18" />
                    </button>
                </template>
                <NuxtLink v-else class="button button-small" to="/login"
                    ><SlidersHorizontal :size="17" /> Start syncing</NuxtLink
                >
            </nav>
        </div>
    </header>
</template>
