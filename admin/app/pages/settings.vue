<script setup lang="ts">
import {LockKeyhole, Pencil, RefreshCw} from "lucide-vue-next"
import type {ApplicationSettings} from "../../shared/contracts"
import {errorLabel} from "../utils/format"

type Field = ApplicationSettings["groups"][number]["fields"][number]
const {data, status, error, refresh} = await useFetch<ApplicationSettings>("/api/settings")
const selected = ref("SMTP")
const group = computed(() => data.value?.groups.find(({label}) => label === selected.value))
const editing = ref(false)
const saving = ref(false)
const saved = ref(false)
const saveError = ref("")
const changes = ref<Partial<Record<Field["name"], string | null>>>({})
const dirty = computed(() => Object.keys(changes.value).length > 0)

function selectGroup(label: string) {
    selected.value = label
    saved.value = false
}

function edit() {
    changes.value = {}
    saved.value = false
    saveError.value = ""
    editing.value = true
}

function cancel() {
    changes.value = {}
    saveError.value = ""
    editing.value = false
}

function setField(field: Field, value: string) {
    if (field.secret ? value === "" : value === field.value) delete changes.value[field.name]
    else changes.value[field.name] = value
}

async function save() {
    if (!data.value || !dirty.value || saving.value) return
    saving.value = true
    saveError.value = ""
    try {
        data.value = await $fetch<ApplicationSettings>("/api/settings", {method: "PATCH", body: {revision: data.value.revision, changes: changes.value}})
        cancel()
        saved.value = true
    } catch (failure) {
        saveError.value = errorLabel(failure)
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <div class="page-heading">
        <div>
            <p class="eyebrow">CONFIGURATION</p>
            <h1>Application settings</h1>
            <p class="muted">Manage provider connections, email delivery, and application behavior.</p>
        </div>
        <button class="icon-button" title="Reload settings" aria-label="Reload settings" :disabled="editing || status === 'pending'" @click="refresh()"><RefreshCw :size="20" /></button>
    </div>
    <p v-if="error" role="alert" class="notice error">{{ errorLabel(error) }}</p>
    <p v-if="status === 'pending' && !data" role="status">Loading settings...</p>
    <template v-if="data && group">
        <div class="settings-notice">
            <LockKeyhole :size="18" aria-hidden="true" />
            <span>Settings are encrypted in the database. Existing secrets are never shown here.</span>
        </div>
        <nav class="settings-groups" aria-label="Settings categories">
            <button v-for="item in data.groups" :key="item.label" type="button" :aria-pressed="selected === item.label" :disabled="editing" @click="selectGroup(item.label)">
                {{ item.label }}
            </button>
        </nav>
        <section class="settings-section" :aria-label="group.label">
            <div class="section-heading">
                <div>
                    <h2>{{ group.label }}</h2>
                    <p class="muted">{{ editing ? "Change only what you want to update. Leave secret inputs blank to keep their values." : "Effective settings and where they come from." }}</p>
                </div>
                <button v-if="!editing" type="button" @click="edit"><Pencil :size="16" /> Edit settings</button>
            </div>
            <p v-if="saved" class="notice" role="status">Settings saved. Running services pick up changes within about 10 seconds.</p>
            <dl v-if="!editing" class="settings-fields">
                <div v-for="field in group.fields" :key="field.name" class="setting-field">
                    <dt>{{ field.label }}</dt>
                    <dd>{{ field.secret ? (field.configured ? "•••••••• (configured)" : "Not configured") : field.value || "Not set" }}</dd>
                    <dd class="muted setting-source">{{ field.stored ? "Database" : "Deployment / default" }}</dd>
                </div>
            </dl>
            <form v-else @submit.prevent="save">
                <fieldset class="settings-fields" :disabled="saving">
                    <div v-for="field in group.fields" :key="field.name" class="setting-field">
                        <label :for="field.name">{{ field.label }}</label>
                        <input
                            :id="field.name"
                            :type="field.secret ? 'password' : 'text'"
                            :aria-describedby="field.hint ? field.name + '-hint' : undefined"
                            :value="changes[field.name] ?? field.value ?? ''"
                            :placeholder="field.secret ? (field.configured ? 'Enter a replacement' : 'Not configured') : undefined"
                            :disabled="changes[field.name] === null"
                            :autocomplete="field.secret ? 'new-password' : 'off'"
                            :maxlength="16384"
                            @input="setField(field, ($event.target as HTMLInputElement).value)"
                        />
                        <span v-if="field.hint" :id="field.name + '-hint'" class="muted">{{ field.hint }}</span>
                        <div class="field-actions">
                            <template v-if="changes[field.name] === null || (field.secret && changes[field.name] === '')">
                                <span class="muted">{{ changes[field.name] === null ? "Will use deployment value" : "Will clear this value" }}</span>
                                <button type="button" @click="delete changes[field.name]">Undo</button>
                            </template>
                            <template v-else>
                                <button v-if="field.stored" type="button" @click="changes[field.name] = null">Use deployment value</button>
                                <button v-if="field.secret && field.configured" type="button" @click="changes[field.name] = ''">Clear value</button>
                            </template>
                        </div>
                    </div>
                </fieldset>
                <p v-if="saveError" role="alert" class="notice error">{{ saveError }}</p>
                <div class="actions">
                    <button class="primary" type="submit" :disabled="saving || !dirty">{{ saving ? "Saving..." : "Save changes" }}</button>
                    <button type="button" :disabled="saving" @click="cancel">Cancel</button>
                </div>
            </form>
        </section>
    </template>
</template>

<style scoped>
.settings-notice,
.settings-groups,
.field-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.settings-notice {
    padding: 12px 16px;
    background: #eaf2ed;
    border: 1px solid var(--line);
    border-radius: 5px;
    color: var(--green);
    font-size: 14px;
}
.settings-notice svg {
    flex-shrink: 0;
}
.settings-groups {
    flex-wrap: wrap;
    margin: 20px 0;
}
.settings-groups [aria-pressed="true"] {
    background: var(--green);
    border-color: var(--green);
    color: white;
    opacity: 1;
}
.settings-section {
    padding: clamp(14px, 3vw, 24px);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
}
.settings-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
    gap: 12px;
    margin: 16px 0;
    border: 0;
    padding: 0;
    min-width: 0;
}
.setting-field {
    display: grid;
    align-content: start;
    gap: 7px;
    min-width: 0;
    padding: 14px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 5px;
}
.setting-field dt,
.setting-field label {
    font-weight: 800;
    font-size: 13px;
}
.setting-field dd {
    margin: 0;
    overflow-wrap: anywhere;
}
.setting-source,
.field-actions,
.setting-field > span {
    font-size: 12px;
}
.field-actions {
    flex-wrap: wrap;
}
.field-actions button {
    min-height: 32px;
    padding: 5px 8px;
    font-size: 12px;
}
</style>
