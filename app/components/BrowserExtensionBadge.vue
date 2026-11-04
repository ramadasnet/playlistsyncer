<script setup lang="ts">
import {Puzzle} from "lucide-vue-next"

// online is undefined when the status is unknown, for example on pages that do not load the account list.
// The explicit undefined default stops Vue from casting a missing boolean prop to false.
const props = withDefaults(defineProps<{online?: boolean}>(), {online: undefined})
const title = computed(() =>
    props.online === false ? "Runs in your browser through the PlaylistSyncer extension. The extension is offline: open your browser to let it run." : "Runs in your browser through the PlaylistSyncer extension, not on the PlaylistSyncer server."
)
</script>

<template>
    <span class="extension-badge" :class="{offline: online === false, online: online === true}" :title="title">
        <Puzzle :size="14" aria-hidden="true" />
        Runs in your browser
        <span v-if="online !== undefined" class="extension-badge-status">{{ online ? "online" : "offline" }}</span>
    </span>
</template>
