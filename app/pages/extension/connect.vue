<script setup lang="ts">
import {CircleAlert, LoaderCircle, Puzzle} from "lucide-vue-next"

definePageMeta({
    // Keep the extension's request in the redirect so the user returns here after signing in.
    middleware: [
        (to) => {
            const auth = useAuthStore()
            if (auth.loaded && !auth.user) {
                return navigateTo({path: "/login", query: {redirect: to.fullPath}})
            }
        }
    ]
})
usePageSeo({title: "Connect Browser Extension", robots: "noindex"})

const route = useRoute()
const auth = useAuthStore()
const param = (name: string) => (typeof route.query[name] === "string" ? (route.query[name] as string) : "")
const request = {
    redirectUri: param("redirect_uri"),
    codeChallenge: param("code_challenge"),
    codeChallengeMethod: param("code_challenge_method"),
    state: param("state"),
    browser: param("browser") === "firefox" ? "firefox" : "chrome"
}
const browserName = request.browser === "firefox" ? "Firefox" : "Chrome"
const busy = ref<"" | "allow" | "deny">("")
const done = ref(false)
const errorMessage = ref(request.redirectUri && request.codeChallenge && request.state && request.codeChallengeMethod === "S256" ? "" : "This link is incomplete. Click Connect in the PlaylistSyncer extension again.")

function statusMessage(error: unknown, fallback: string): string {
    const data = error && typeof error === "object" && "data" in error ? (error as {data?: {statusMessage?: string}}).data : undefined
    return data?.statusMessage || fallback
}

// Ask the server for the redirect back to the extension, with a one-time code when the user allows the link.
async function respond(allow: boolean) {
    busy.value = allow ? "allow" : "deny"
    errorMessage.value = ""
    try {
        const result = await api<{redirectUrl: string}>("/api/me/extension/authorize", {method: "POST", body: {...request, allow}})
        done.value = true
        window.location.assign(result.redirectUrl)
    } catch (error) {
        errorMessage.value = statusMessage(error, "The extension could not be connected")
        busy.value = ""
    }
}
</script>

<template>
    <div class="shell page-shell confirm-page">
        <section class="settings-section" aria-labelledby="extension-connect-heading">
            <div class="settings-heading">
                <div>
                    <p class="eyebrow">Browser extension</p>
                    <h2 id="extension-connect-heading">Connect the PlaylistSyncer extension</h2>
                </div>
                <CircleAlert v-if="errorMessage" :size="22" class="warning-icon" />
                <Puzzle v-else :size="22" />
            </div>
            <div class="confirm-copy">
                <div v-if="errorMessage" class="notice notice-error" role="alert">{{ errorMessage }}</div>
                <p v-if="done">You can close this window and go back to the extension.</p>
                <template v-else-if="!errorMessage || busy === ''">
                    <p>
                        The PlaylistSyncer extension in {{ browserName }} asks to link to <strong>{{ auth.user?.displayName }}</strong
                        >.
                    </p>
                    <p>
                        It then runs your Spotify and Amazon Music syncs in this browser, with the music service sign-in you already have. Your music service password and session stay in the browser; PlaylistSyncer only receives playlists and tracks.
                    </p>
                    <div class="dialog-actions">
                        <button class="button button-secondary" type="button" :disabled="Boolean(busy) || !request.redirectUri" @click="respond(false)"><LoaderCircle v-if="busy === 'deny'" class="spin" :size="17" />Cancel</button>
                        <button class="button button-primary" type="button" :disabled="Boolean(busy) || !request.redirectUri || !request.codeChallenge" @click="respond(true)">
                            <LoaderCircle v-if="busy === 'allow'" class="spin" :size="17" />Allow
                        </button>
                    </div>
                </template>
            </div>
        </section>
    </div>
</template>
