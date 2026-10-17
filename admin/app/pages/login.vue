<script setup lang="ts">
import {ArrowUpRight} from "lucide-vue-next"
definePageMeta({layout: false})
</script>

<template>
    <main class="login-shell">
        <section class="login-content">
            <img src="/logo-mark.png" alt="" width="64" height="64" />
            <p class="eyebrow">PLAYLISTSYNCER / ADMINISTRATION</p>
            <h1>Sign in</h1>
            <p class="muted">Authorized staff only</p>
            <a class="button primary" href="/api/auth/google">Sign in with Google<ArrowUpRight :size="18" /></a>
        </section>
    </main>
</template>
