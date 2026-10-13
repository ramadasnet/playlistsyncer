<script setup lang="ts">
import {CheckCircle2, CircleAlert, LoaderCircle} from "lucide-vue-next"

useSeoMeta({title: "Confirm Email"})

const route = useRoute()
const auth = useAuthStore()
const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""))
const busy = ref(false)
const success = ref(false)
const errorMessage = ref(token.value ? "" : "This confirmation link is missing a token.")

function statusMessage(error: unknown, fallback: string): string {
    if (error && typeof error === "object" && "data" in error) {
        const data = (error as {data?: {statusMessage?: string}}).data
        if (data?.statusMessage) {
            return data.statusMessage
        }
    }
    if (error instanceof Error && error.message) {
        return error.message
    }
    return fallback
}

async function confirm() {
    if (!token.value) {
        errorMessage.value = "This confirmation link is missing a token."
        return
    }
    busy.value = true
    errorMessage.value = ""
    try {
        const result = await api<{ok: true; user: typeof auth.user}>("/api/auth/confirm-email", {
            method: "POST",
            body: {token: token.value}
        })
        auth.setUser(result.user)
        success.value = true
        if (result.user) {
            await navigateTo("/account?email=confirmed")
        }
    } catch (error) {
        errorMessage.value = statusMessage(error, "This confirmation link is invalid or has expired")
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <div class="shell page-shell confirm-page">
        <section class="settings-section" aria-labelledby="confirm-heading">
            <div class="settings-heading">
                <div>
                    <p class="eyebrow">Email confirmation</p>
                    <h2 id="confirm-heading">Confirm your email address</h2>
                </div>
                <CheckCircle2 v-if="success" :size="22" class="success-icon" />
                <CircleAlert v-else :size="22" class="warning-icon" />
            </div>
            <div class="confirm-copy">
                <div v-if="errorMessage" class="notice notice-error" role="alert">{{ errorMessage }}</div>
                <template v-else-if="success">
                    <p>Your email address is confirmed. Sign in to continue with PlaylistSyncer.</p>
                    <NuxtLink class="button button-primary" to="/login">Continue</NuxtLink>
                </template>
                <template v-else>
                    <p>Use the button below to confirm the email address for this PlaylistSyncer account.</p>
                    <button class="button button-primary" type="button" :disabled="busy || !token" @click="confirm"><LoaderCircle v-if="busy" class="spin" :size="17" /> Confirm email address</button>
                </template>
            </div>
        </section>
    </div>
</template>
