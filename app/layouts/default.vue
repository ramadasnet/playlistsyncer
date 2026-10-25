<template>
    <div class="app-frame">
        <AppHeader />
        <main>
            <slot />
        </main>
        <footer class="site-footer">
            <div class="shell footer-inner">
                <p><strong>PlaylistSyncer</strong> · Your playlists, no matter where you go</p>
                <nav aria-label="Footer navigation">
                    <NuxtLink to="/features">Features</NuxtLink>
                    <NuxtLink to="/support">Support</NuxtLink>
                    <NuxtLink to="/terms">Terms</NuxtLink>
                    <NuxtLink v-if="showImpressum" to="/impressum">Impressum</NuxtLink>
                    <span>© {{ new Date().getFullYear() }}</span>
                </nav>
            </div>
        </footer>
    </div>
</template>

<script setup lang="ts">
const {showImpressum} = await useShowImpressum()
const route = useRoute()

onMounted(() => {
    if (route.query.appleMusic === "authorize") {
        return
    }
    closeReservedAppleMusicWindow()
})
</script>
