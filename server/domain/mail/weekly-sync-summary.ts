import type {ObjectId} from "mongodb"
import type {
    AccountTier,
    SyncRunDocument,
    SyncRunTrackReference,
    SyncSnapshotDocument,
    SyncTaskDocument,
    UserDocument
} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import type {OutboundEmail} from "./send"

export const weeklySyncSummaryIntervalMs = 7 * 24 * 60 * 60 * 1000
export const weeklySyncSummaryLeaseMs = 15 * 60 * 1000
export const weeklySyncSummaryBatchSize = 25

export interface WeeklySummaryTrack {
    title: string
    artists: string[]
}

export interface WeeklySummaryPlaylist {
    playlistName: string
    addedTracks: WeeklySummaryTrack[]
    removedTracks: WeeklySummaryTrack[]
}

export interface WeeklySyncSummary {
    playlists: WeeklySummaryPlaylist[]
}

export interface WeeklySummaryStore {
    claimDueUser(dueBefore: Date, now: Date): Promise<UserDocument | null>
    findTasks(userId: ObjectId): Promise<SyncTaskDocument[]>
    findRuns(taskIds: ObjectId[], since: Date, until: Date, exclusiveStart: boolean): Promise<SyncRunDocument[]>
    findSnapshots(taskIds: ObjectId[]): Promise<SyncSnapshotDocument[]>
    markProcessed(userId: ObjectId, processedAt: Date): Promise<void>
    disablePreference(userId: ObjectId, processedAt: Date): Promise<void>
    releaseClaim(userId: ObjectId): Promise<void>
}

export function evaluateWeeklySyncSummaryPreference(input: {
    tier: AccountTier
    email?: string
    enabled: boolean
}): {ok: true} | {ok: false; statusCode: number; statusMessage: string} {
    if (input.tier !== "pro") {
        return {ok: false, statusCode: 403, statusMessage: "Weekly sync summaries require a PRO account"}
    }
    if (input.enabled && !input.email) {
        return {
            ok: false,
            statusCode: 400,
            statusMessage: "Confirm an email address before enabling weekly sync summaries"
        }
    }
    return {ok: true}
}

export function isWeeklySyncSummaryDue(
    user: Pick<UserDocument, "weeklySyncSummaryEnabled" | "weeklySyncSummarySentAt" | "email">,
    now: Date,
    intervalMs = weeklySyncSummaryIntervalMs
): boolean {
    if (!user.weeklySyncSummaryEnabled || !user.email) {
        return false
    }
    if (!user.weeklySyncSummarySentAt) {
        return true
    }
    return now.getTime() - user.weeklySyncSummarySentAt.getTime() >= intervalMs
}

export function weeklySummaryWindowStart(
    sentAt: Date | undefined,
    now: Date,
    intervalMs = weeklySyncSummaryIntervalMs
): Date {
    return sentAt ?? new Date(now.getTime() - intervalMs)
}

export function formatTrackLabel(track: Pick<WeeklySummaryTrack, "title" | "artists">): string {
    const title = track.title.trim() || "Unknown track"
    const artists = track.artists.map((artist) => artist.trim()).filter(Boolean)
    return artists.length ? `${title} — ${artists.join(", ")}` : title
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
}

export function playlistNameForChange(
    task: SyncTaskDocument | undefined,
    playlistId: string,
    recordedName?: string
): string {
    if (recordedName?.trim()) {
        return recordedName
    }
    const mapping = task?.playlistMappings?.find(
        (item) => item.sourcePlaylistId === playlistId || item.destinationPlaylistId === playlistId
    )
    if (mapping?.name.trim()) {
        return mapping.name
    }
    if (task?.source.playlistId === playlistId && task.source.name.trim()) {
        return task.source.name
    }
    if (task?.destination.playlistId === playlistId && task.destination.name.trim()) {
        return task.destination.name
    }
    return "Untitled playlist"
}

function trackIdentity(ref: SyncRunTrackReference): string {
    return `${ref.providerAccountId.toHexString()}:${ref.playlistId}:${ref.providerTrackId}:${ref.providerItemId ?? ""}`
}

function titleFromSnapshot(
    snapshot: SyncSnapshotDocument | undefined,
    ref: SyncRunTrackReference
): Pick<WeeklySummaryTrack, "title" | "artists"> | undefined {
    if (!snapshot) {
        return undefined
    }
    const match = [...snapshot.sourceItems, ...snapshot.destinationItems].find(
        (item) =>
            item.providerTrackId === ref.providerTrackId ||
            (ref.providerItemId !== undefined && item.providerItemId === ref.providerItemId)
    )
    return match ? {title: match.title, artists: match.artists} : undefined
}

function resolveTrack(ref: SyncRunTrackReference, snapshot: SyncSnapshotDocument | undefined): WeeklySummaryTrack {
    if (ref.title?.trim()) {
        return {title: ref.title, artists: ref.artists || []}
    }
    const fromSnapshot = titleFromSnapshot(snapshot, ref)
    return {
        title: fromSnapshot?.title?.trim() || "Unknown track",
        artists: fromSnapshot?.artists || []
    }
}

function sortTracks(tracks: WeeklySummaryTrack[]): WeeklySummaryTrack[] {
    return [...tracks].sort((left, right) => formatTrackLabel(left).localeCompare(formatTrackLabel(right)))
}

export function summarizeSyncChanges(
    runs: SyncRunDocument[],
    tasks: SyncTaskDocument[],
    snapshots: SyncSnapshotDocument[] = []
): WeeklySyncSummary {
    const tasksById = new Map(tasks.flatMap((task) => (task._id ? [[task._id.toHexString(), task] as const] : [])))
    const snapshotsByTask = new Map(snapshots.map((snapshot) => [snapshot.taskId.toHexString(), snapshot]))
    const playlists = new Map<
        string,
        {playlistName: string; added: Map<string, WeeklySummaryTrack>; removed: Map<string, WeeklySummaryTrack>}
    >()

    for (const run of runs) {
        if (run.status === "running") {
            continue
        }
        const task = tasksById.get(run.taskId.toHexString())
        const snapshot = snapshotsByTask.get(run.taskId.toHexString())
        const record = (refs: SyncRunTrackReference[], kind: "added" | "removed") => {
            for (const ref of refs) {
                const playlistKey = `${ref.providerAccountId.toHexString()}:${ref.playlistId}`
                let playlist = playlists.get(playlistKey)
                if (!playlist) {
                    playlist = {
                        playlistName: playlistNameForChange(task, ref.playlistId, ref.playlistName),
                        added: new Map(),
                        removed: new Map()
                    }
                    playlists.set(playlistKey, playlist)
                }
                playlist[kind].set(trackIdentity(ref), resolveTrack(ref, snapshot))
            }
        }
        record(run.addedTracks || [], "added")
        record(run.removedTracks || [], "removed")
    }

    return {
        playlists: [...playlists.values()]
            .map((playlist) => ({
                playlistName: playlist.playlistName,
                addedTracks: sortTracks([...playlist.added.values()]),
                removedTracks: sortTracks([...playlist.removed.values()])
            }))
            .filter((playlist) => playlist.addedTracks.length || playlist.removedTracks.length)
            .sort((left, right) => left.playlistName.localeCompare(right.playlistName))
    }
}

export function weeklySyncSummaryHasChanges(summary: WeeklySyncSummary): boolean {
    return summary.playlists.some((playlist) => playlist.addedTracks.length || playlist.removedTracks.length)
}

function playlistCountLabel(count: number): string {
    return count === 1 ? "1 playlist" : `${count} playlists`
}

export function buildWeeklySyncSummaryEmail(input: {
    to: string
    displayName?: string
    summary: WeeklySyncSummary
    appUrl?: string
    appName?: string
}): OutboundEmail {
    const appName = input.appName || "PlaylistSyncer"
    const greeting = input.displayName?.trim() ? `Hi ${input.displayName.trim()},` : "Hi,"
    const playlistCount = input.summary.playlists.length
    const intro = `This week ${appName} added or removed tracks on ${playlistCountLabel(playlistCount)}.`
    const textPlaylists = input.summary.playlists.flatMap((playlist) => {
        const lines = ["", playlist.playlistName]
        if (playlist.addedTracks.length) {
            lines.push("Added:")
            lines.push(...playlist.addedTracks.map((track) => `- ${formatTrackLabel(track)}`))
        }
        if (playlist.removedTracks.length) {
            lines.push("Removed:")
            lines.push(...playlist.removedTracks.map((track) => `- ${formatTrackLabel(track)}`))
        }
        return lines
    })
    const htmlPlaylists = input.summary.playlists
        .map((playlist) => {
            const added = playlist.addedTracks.length
                ? `<p>Added</p><ul>${playlist.addedTracks
                      .map((track) => `<li>${escapeHtml(formatTrackLabel(track))}</li>`)
                      .join("")}</ul>`
                : ""
            const removed = playlist.removedTracks.length
                ? `<p>Removed</p><ul>${playlist.removedTracks
                      .map((track) => `<li>${escapeHtml(formatTrackLabel(track))}</li>`)
                      .join("")}</ul>`
                : ""
            return `<h2>${escapeHtml(playlist.playlistName)}</h2>${added}${removed}`
        })
        .join("")
    const syncUrl = input.appUrl ? `${input.appUrl}/sync` : undefined
    const text = [
        greeting,
        "",
        intro,
        ...textPlaylists,
        ...(syncUrl ? ["", `Open ${appName} to review your tasks:`, syncUrl] : [])
    ].join("\n")
    const html = [
        `<p>${escapeHtml(greeting)}</p>`,
        `<p>${escapeHtml(intro)}</p>`,
        htmlPlaylists,
        ...(syncUrl ? [`<p><a href="${escapeHtml(syncUrl)}">Review your sync tasks</a></p>`] : [])
    ].join("")
    return {
        to: input.to,
        subject: `Your ${appName} weekly sync summary`,
        text,
        html
    }
}

function dueUserFilter(dueBefore: Date, now: Date) {
    return {
        weeklySyncSummaryEnabled: true as const,
        email: {$type: "string" as const, $ne: ""},
        $and: [
            {$or: [{weeklySyncSummarySentAt: {$exists: false}}, {weeklySyncSummarySentAt: {$lte: dueBefore}}]},
            {
                $or: [
                    {weeklySyncSummaryLeaseExpiresAt: {$exists: false}},
                    {weeklySyncSummaryLeaseExpiresAt: {$lt: now}}
                ]
            }
        ]
    }
}

export function createWeeklySummaryStore(db: Awaited<ReturnType<typeof collections>>): WeeklySummaryStore {
    return {
        claimDueUser(dueBefore, now) {
            return db.users.findOneAndUpdate(
                dueUserFilter(dueBefore, now),
                {
                    $set: {
                        weeklySyncSummaryLeaseExpiresAt: new Date(now.getTime() + weeklySyncSummaryLeaseMs),
                        updatedAt: now
                    }
                },
                {returnDocument: "after", sort: {weeklySyncSummarySentAt: 1}}
            )
        },
        findTasks(userId) {
            return db.syncTasks.find({userId}).toArray()
        },
        findRuns(taskIds, since, until, exclusiveStart) {
            return db.syncRuns
                .find({
                    taskId: {$in: taskIds},
                    finishedAt: exclusiveStart ? {$gt: since, $lte: until} : {$gte: since, $lte: until}
                })
                .toArray()
        },
        findSnapshots(taskIds) {
            return db.syncSnapshots.find({taskId: {$in: taskIds}}).toArray()
        },
        async markProcessed(userId, processedAt) {
            await db.users.updateOne(
                {_id: userId},
                {
                    $set: {weeklySyncSummarySentAt: processedAt, updatedAt: processedAt},
                    $unset: {weeklySyncSummaryLeaseExpiresAt: ""}
                }
            )
        },
        async disablePreference(userId, processedAt) {
            await db.users.updateOne(
                {_id: userId},
                {
                    $set: {weeklySyncSummaryEnabled: false, updatedAt: processedAt},
                    $unset: {weeklySyncSummaryLeaseExpiresAt: ""}
                }
            )
        },
        async releaseClaim(userId) {
            await db.users.updateOne({_id: userId}, {$unset: {weeklySyncSummaryLeaseExpiresAt: ""}})
        }
    }
}

export async function sendDueWeeklySyncSummaries(input: {
    now?: Date
    limit?: number
    store: WeeklySummaryStore
    resolveTier: (user: UserDocument) => AccountTier
    send: (message: OutboundEmail) => Promise<boolean>
    appUrl?: string
}): Promise<{processed: number; sent: number; skipped: number}> {
    const now = input.now ?? new Date()
    const limit = input.limit ?? weeklySyncSummaryBatchSize
    const dueBefore = new Date(now.getTime() - weeklySyncSummaryIntervalMs)
    let processed = 0
    let sent = 0
    let skipped = 0
    let eligible = 0
    const seen = new Set<string>()

    while (eligible < limit) {
        const user = await input.store.claimDueUser(dueBefore, now)
        if (!user?._id) {
            break
        }
        const userId = user._id.toHexString()
        if (seen.has(userId)) {
            await input.store.releaseClaim(user._id)
            break
        }
        seen.add(userId)
        processed++
        if (input.resolveTier(user) !== "pro") {
            await input.store.disablePreference(user._id, now)
            skipped++
            continue
        }
        if (!isWeeklySyncSummaryDue(user, now)) {
            await input.store.releaseClaim(user._id)
            skipped++
            continue
        }
        eligible++
        const since = weeklySummaryWindowStart(user.weeklySyncSummarySentAt, now)
        const tasks = await input.store.findTasks(user._id)
        const taskIds = tasks.flatMap((task) => (task._id ? [task._id] : []))
        const runs = taskIds.length
            ? await input.store.findRuns(taskIds, since, now, Boolean(user.weeklySyncSummarySentAt))
            : []
        const snapshots = taskIds.length ? await input.store.findSnapshots(taskIds) : []
        const summary = summarizeSyncChanges(runs, tasks, snapshots)
        if (!weeklySyncSummaryHasChanges(summary)) {
            await input.store.markProcessed(user._id, now)
            skipped++
            continue
        }
        try {
            const delivered = await input.send(
                buildWeeklySyncSummaryEmail({
                    to: user.email!,
                    displayName: user.displayName,
                    summary,
                    appUrl: input.appUrl
                })
            )
            if (!delivered) {
                await input.store.releaseClaim(user._id)
                skipped++
                continue
            }
            await input.store.markProcessed(user._id, now)
            sent++
        } catch {
            await input.store.releaseClaim(user._id)
            skipped++
        }
    }

    return {processed, sent, skipped}
}
