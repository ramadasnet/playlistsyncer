<script setup lang="ts">
const config = useRuntimeConfig()
const supportEmail = computed(() => String(config.public.supportEmail))

useSeoMeta({
    title: "Impressum · PlaylistSyncer",
    description: "Legal notice for PlaylistSyncer according to §5 TMG."
})
</script>

<template>
    <div class="shell page-shell">
        <PageHeading title="Impressum" description="Responsible according to §5 TMG." />
        <section class="legal-panel" aria-labelledby="impressum-responsible">
            <h2 id="impressum-responsible">Responsible according to §5 TMG</h2>
            <p>
                <strong>Igor Ramadas Leite Nogueira</strong><br />
                Software Engineer<br />
                Einzelunternehmen<br />
                Business ID: DE454468590
            </p>
            <p>
                Straße 18 16<br />
                13089 Berlin<br />
                Germany
            </p>
            <p>
                Website:
                <a href="https://playlistsyncer.com">https://playlistsyncer.com</a>
                <br />
                Email:
                <a :href="`mailto:${supportEmail}`">{{ supportEmail }}</a>
            </p>
        </section>
    </div>
</template>
