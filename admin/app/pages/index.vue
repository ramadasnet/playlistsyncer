<script setup lang="ts">
import {RefreshCw} from "lucide-vue-next"
import type {Statistics} from "../../shared/contracts"
import {errorLabel} from "../utils/format"
const providerNames: Record<string, string> = {spotify: "Spotify", tidal: "TIDAL", youtube: "YouTube Music", soundcloud: "SoundCloud", apple: "Apple Music", amazon: "Amazon Music"}
const {data, status, error, refresh} = await useFetch<Statistics>("/api/stats")
const metrics = computed(() =>
    data.value
        ? [
              {label: "Total users", value: data.value.users, note: `${data.value.newUsers24h} joined in 24h`},
              {label: "Effective PRO users", value: data.value.effectivePro, note: `${data.value.paidSubscriptions} paid / trialing subscriptions`},
              {label: "Sync tasks", value: data.value.tasks, note: `${data.value.activeTasks} active / ${data.value.pausedTasks} paused`},
              {label: "Tracked playlists", value: data.value.trackedPlaylists, note: "Distinct known account / playlist pairs"},
              {label: "Emails accepted by SMTP", value: data.value.email?.accepted ?? "Not recorded", note: data.value.email ? "Since " : "Counting starts with the next send", since: data.value.email?.since},
              {label: "Weekly summary subscribers", value: data.value.summaryUsers, note: `${data.value.email?.failed || 0} SMTP failures recorded`}
          ]
        : []
)
</script>

<template>
    <div class="page-heading">
        <div>
            <p class="eyebrow">OPERATIONS</p>
            <h1>Overview</h1>
            <p class="muted">
                <template v-if="data">Updated <DateLabel :value="data.measuredAt" /></template><template v-else>Current service activity</template>
            </p>
        </div>
        <button class="icon-button" title="Refresh statistics" aria-label="Refresh statistics" :disabled="status === 'pending'" @click="refresh()"><RefreshCw :size="20" /></button>
    </div>
    <p v-if="error" role="alert" class="notice error">{{ errorLabel(error) }}</p>
    <p v-if="status === 'pending' && !data" role="status">Loading statistics...</p>
    <template v-if="data">
        <dl class="metric-grid">
            <div v-for="metric in metrics" :key="metric.label" class="metric">
                <dt>{{ metric.label }}</dt>
                <dd>{{ typeof metric.value === "number" ? metric.value.toLocaleString() : metric.value }}</dd>
                <p>{{ metric.note }}<DateLabel v-if="metric.since" :value="metric.since" /></p>
            </div>
        </dl>
        <section class="section-band">
            <div class="section-heading">
                <h2>Sync health</h2>
                <span class="muted">Last 24 hours</span>
            </div>
            <div class="health-grid">
                <NuxtLink to="/tasks?status=needs_attention" class="health-item"
                    ><strong class="danger">{{ data.attentionTasks }}</strong
                    ><span>Tasks needing attention</span></NuxtLink
                >
                <div class="health-item">
                    <strong>{{ data.runningTasks }}</strong
                    ><span>Leases currently held</span>
                </div>
                <div class="health-item">
                    <strong class="success">{{ data.succeededRuns24h }}</strong
                    ><span>Successful runs</span>
                </div>
                <div class="health-item">
                    <strong class="danger">{{ data.failedRuns24h }}</strong
                    ><span>Failed runs</span>
                </div>
                <div class="health-item">
                    <strong>{{ data.partialRuns24h }}</strong
                    ><span>Partial runs</span>
                </div>
            </div>
        </section>
        <section class="section-band">
            <div class="section-heading">
                <h2>Users by music provider</h2>
                <span class="muted">Connected accounts</span>
            </div>
            <div class="provider-grid">
                <NuxtLink v-for="provider in data.providerUsers" :key="provider.provider" :to="`/users?provider=${provider.provider}`" class="provider-count"
                    ><span class="provider-dot" :class="provider.provider"></span><span>{{ providerNames[provider.provider] || provider.provider }}</span
                    ><strong>{{ provider.users }}</strong></NuxtLink
                >
            </div>
        </section>
        <section class="section-band">
            <h2>Recent admin activity</h2>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Admin</th>
                            <th>Action</th>
                            <th>Target</th>
                            <th>Result</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="entry in data.audit" :key="entry.id">
                            <td><DateLabel :value="entry.createdAt" /></td>
                            <td>{{ entry.actor }}</td>
                            <td>{{ entry.action }}</td>
                            <td class="mono">{{ entry.target }}</td>
                            <td>
                                <span class="badge" :class="entry.status">{{ entry.status }}</span>
                            </td>
                        </tr>
                        <tr v-if="!data.audit.length">
                            <td colspan="5" class="empty">No admin changes recorded.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </template>
</template>
