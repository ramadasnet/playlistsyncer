<!-- Overlay dialog for focused actions that should not sit inline on the page. -->

<script setup lang="ts">
import {X} from "lucide-vue-next"

const open = defineModel<boolean>({required: true})
const props = defineProps<{title: string; busy?: boolean}>()

const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const titleId = useId()

// Keep the native dialog element in sync with the v-model.
function syncOpenState() {
    const el = dialog.value
    if (!el) {
        return
    }
    if (open.value && !el.open) {
        el.showModal()
    } else if (!open.value && el.open) {
        el.close()
    }
}

onMounted(syncOpenState)
watch(open, syncOpenState)

// Ignore dismissals while a submit is still in flight.
function requestClose() {
    if (props.busy) {
        return
    }
    open.value = false
}

function onDialogClose() {
    open.value = false
}

function onDialogCancel(event: Event) {
    if (props.busy) {
        event.preventDefault()
    }
}

function onDialogClick(event: MouseEvent) {
    if (event.target === dialog.value) {
        requestClose()
    }
}
</script>

<template>
    <dialog ref="dialog" class="overlay-dialog" :aria-labelledby="titleId" @close="onDialogClose" @cancel="onDialogCancel" @click="onDialogClick">
        <div class="overlay-dialog-card">
            <header class="overlay-dialog-header">
                <h2 :id="titleId">{{ title }}</h2>
                <button class="icon-button" type="button" aria-label="Close" :disabled="busy" @click="requestClose">
                    <X :size="18" />
                </button>
            </header>
            <div class="overlay-dialog-body">
                <slot />
            </div>
        </div>
    </dialog>
</template>
