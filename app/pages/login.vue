<script setup lang="ts">
import {ArrowRight, LockKeyhole} from "lucide-vue-next"

definePageMeta({middleware: () => (useAuthStore().user ? navigateTo("/sync") : undefined)})

const providers = [
    {id: "spotify", detail: "Spotify profile and playlists"},
    {id: "youtube", detail: "Google profile and YouTube playlists"},
    {id: "tidal", detail: "TIDAL profile and playlists"},
    {id: "amazon", detail: "Amazon profile and approved Music access"}
] as const
</script>

<template>
    <div class="auth-page">
        <section class="auth-intro">
            <div>
                <p class="eyebrow light">No new password</p>
                <h1>Bring the account that holds your music.</h1>
                <p>
                    Signing in creates your PlaylistSyncer profile. Add your other music accounts from preferences
                    afterward.
                </p>
            </div>
            <div class="trust-line">
                <LockKeyhole :size="19" /><span>OAuth tokens are encrypted before storage.</span>
            </div>
        </section>
        <section class="auth-options" aria-labelledby="sign-in-title">
            <div>
                <p class="eyebrow">Registration and login</p>
                <h2 id="sign-in-title">Continue with a provider</h2>
                <p>When verified emails match, provider identities join the same account.</p>
            </div>
            <div class="login-list">
                <a
                    v-for="provider in providers"
                    :key="provider.id"
                    class="login-option"
                    :href="`/api/auth/${provider.id}`"
                >
                    <ProviderBadge :provider="provider.id" />
                    <span>{{ provider.detail }}</span>
                    <ArrowRight :size="19" />
                </a>
            </div>
            <p class="legal-copy">
                By continuing, you authorize PlaylistSyncer to manage only the playlist data required for your sync
                tasks.
            </p>
        </section>
    </div>
</template>
