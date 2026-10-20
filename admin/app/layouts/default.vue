<script setup lang="ts">
import {Activity, ChartNoAxesCombined, CreditCard, LogOut, Users} from "lucide-vue-next"
import {errorLabel} from "../utils/format"

const {data: session, refresh} = await useFetch("/api/session", {key: "admin-session"})
const signingOut = ref(false)
const logoutError = ref("")
async function logout() {
    signingOut.value = true
    logoutError.value = ""
    try {
        await $fetch("/api/logout", {method: "POST"})
        await refresh()
        await navigateTo("/login")
    } catch (failure) {
        logoutError.value = errorLabel(failure)
    } finally {
        signingOut.value = false
    }
}
</script>

<template>
    <div class="admin-frame">
        <header class="masthead">
            <NuxtLink to="/" class="brand"
                ><img src="/logo-mark.png" alt="" width="32" height="32" /><span>PlaylistSyncer <small>ADMIN</small></span></NuxtLink
            >
            <div class="identity">
                <span>{{ session?.admin?.email }}</span
                ><button class="icon-button" title="Sign out" aria-label="Sign out" :disabled="signingOut" @click="logout"><LogOut :size="18" /></button>
            </div>
        </header>
        <nav class="primary-nav" aria-label="Administration">
            <NuxtLink to="/"><ChartNoAxesCombined :size="18" />Overview</NuxtLink>
            <NuxtLink to="/users"><Users :size="18" />Users</NuxtLink>
            <NuxtLink to="/subscriptions"><CreditCard :size="18" />Subscriptions</NuxtLink>
            <NuxtLink to="/tasks"><Activity :size="18" />Sync tasks</NuxtLink>
        </nav>
        <main class="workspace">
            <p v-if="session?.creemServer && session.creemServer !== 'prod'" class="notice warning">Creem is in test mode. Subscriptions and billing data shown here are sandbox data, not live payments.</p>
            <p v-if="logoutError" role="alert" class="notice error">{{ logoutError }}</p>
            <slot />
        </main>
    </div>
</template>
