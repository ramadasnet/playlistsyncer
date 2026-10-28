<script setup lang="ts">
import {ArrowRight} from "lucide-vue-next"
import type {Provider} from "~~/shared/types/domain"
import {normalizeRedirect} from "~~/shared/redirect"

definePageMeta({
    middleware: (to) => {
        const user = useAuthStore().user
        if (!user) {
            return
        }
        return navigateTo(user.email || user.tempEmail ? normalizeRedirect(to.query.redirect) : "/account")
    }
})
usePageSeo({
    title: "Login",
    description: "Log in or create an account with your music provider to start syncing playlists.",
    robots: "noindex"
})

const route = useRoute()
const redirectAfter = computed(() => normalizeRedirect(route.query.redirect))
const {enabledProviders} = await useEnabledProviders()

const providerDetails: Record<Provider, string> = {
    spotify: "Login with Spotify",
    tidal: "Login with TIDAL",
    youtube: "Login with Google",
    soundcloud: "Login with SoundCloud",
    apple: "Login with Apple",
    amazon: "Login with Amazon"
}
</script>

<template>
    <div class="shell page-shell login-page">
        <div class="auth-layout">
            <section class="auth-intro">
                <h2>Register</h2>
                <p>To start, all you need to do is to login using your existing account from any of the supported music providers.</p>
            </section>
            <section class="auth-options" aria-labelledby="sign-in-title">
                <div class="auth-options-copy">
                    <h2 id="sign-in-title">Login</h2>
                    <p>Use your existing account from any of the supported music providers to register or login. No extra fluff needed.</p>
                </div>
                <div class="login-list">
                    <a v-for="provider in enabledProviders" :key="provider" class="login-option" :href="`/api/auth/${provider}?redirect=${encodeURIComponent(redirectAfter)}`" @click="provider === 'apple' && beginAppleProviderLogin($event)">
                        <ProviderBadge :provider="provider" />
                        <span>{{ providerDetails[provider] }}</span>
                        <ArrowRight :size="19" />
                    </a>
                    <p v-if="!enabledProviders.length" class="legal-copy login-empty">No music services are available to connect right now.</p>
                </div>
                <p class="legal-copy">By continuing, you authorize PlaylistSyncer to view your account profile on the music provider, and manage the playlist data required for your sync tasks.</p>
            </section>
        </div>
    </div>
</template>
