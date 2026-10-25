<script setup lang="ts">
import {LoaderCircle, LogIn, LogOut, Menu, X} from "lucide-vue-next"
import {planBadgeClass, planBadgeLabel} from "~/utils/plan"

const auth = useAuthStore()
const {safeMode} = useSafeMode()
const open = ref(false)
const route = useRoute()
const showLogoutDialog = ref(false)
const logoutBusy = ref(false)
const logoutError = ref("")

function openLogoutDialog() {
    logoutError.value = ""
    showLogoutDialog.value = true
}

async function confirmLogout() {
    if (logoutBusy.value) return
    logoutBusy.value = true
    logoutError.value = ""
    try {
        await auth.logout()
        showLogoutDialog.value = false
    } catch {
        logoutError.value = "Could not log out. Please try again."
    } finally {
        logoutBusy.value = false
    }
}

watch(
    () => route.fullPath,
    () => (open.value = false)
)
</script>

<template>
    <header class="site-header">
        <div class="shell header-inner">
            <NuxtLink class="brand" to="/" aria-label="PlaylistSyncer home">
                <img class="brand-mark" src="/logo-mark.svg" alt="" width="32" height="32" />
                <span>Playlist<span class="brand-syncer">Syncer</span></span>
            </NuxtLink>

            <button class="icon-button nav-toggle" type="button" :aria-expanded="open" aria-label="Toggle navigation" @click="open = !open">
                <X v-if="open" :size="20" />
                <Menu v-else :size="20" />
            </button>

            <nav class="primary-nav" :class="{open}" aria-label="Primary navigation">
                <NuxtLink to="/features">Features</NuxtLink>
                <template v-if="auth.user">
                    <NuxtLink to="/sync">My Sync Tasks</NuxtLink>
                    <NuxtLink to="/account">Account</NuxtLink>
                </template>
                <span v-if="safeMode" class="plan-badge plan-safe-mode">SAFE MODE</span>
                <template v-if="auth.user">
                    <span class="plan-badge" :class="planBadgeClass(auth.user)">{{ planBadgeLabel(auth.user, true) }}</span>
                    <button class="icon-button" type="button" title="Log out" aria-label="Log out" aria-haspopup="dialog" @click="openLogoutDialog">
                        <LogOut :size="18" />
                    </button>
                </template>
                <NuxtLink v-else class="button button-small" to="/login"><LogIn :size="17" /> Login</NuxtLink>
            </nav>
        </div>
    </header>
    <OverlayDialog v-model="showLogoutDialog" title="Log out" :busy="logoutBusy">
        <p class="confirm-dialog-copy">Are you sure you want to log out of PlaylistSyncer?</p>
        <p v-if="logoutError" class="dialog-error" role="alert">{{ logoutError }}</p>
        <div class="dialog-actions">
            <button class="button button-secondary" type="button" :disabled="logoutBusy" @click="showLogoutDialog = false">Cancel</button>
            <button class="button button-primary" type="button" :disabled="logoutBusy" @click="confirmLogout">
                <LoaderCircle v-if="logoutBusy" class="spin" :size="17" />
                <LogOut v-else :size="17" />
                Log out
            </button>
        </div>
    </OverlayDialog>
</template>
