// Execute playlist and account synchronization while recording resumable runs.
import {AsyncLocalStorage} from "node:async_hooks"
import {randomUUID} from "node:crypto"
import {clearInterval, setInterval} from "node:timers"
import {ObjectId} from "mongodb"
import type {CanonicalTrack, PlaylistMapping, ProviderAccountDocument, SyncRunProgress, SyncRunTrackReference, SyncTaskDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {resolveEntitlement} from "../billing/entitlement"
import {applyTaskEntitlement} from "../billing/task-entitlement"
import {isMissingPlaylistError} from "../providers/http"
import {getProviderAdapter, type ProviderPlaylist, type ProviderTrack} from "../providers"
import {readSyncFailureReason, reverseSyncCaseFor, type ReverseSyncCase, type ReverseSyncRequest, type SyncFailureReason} from "../../../shared/reverse-sync"
import {assertReverseSyncAvailable} from "./reverse-sync"
import {proSyncIntervalMs} from "~~/shared/sync-cadence"
import {extendedLeaseExpiry, initialSyncLeaseMs, syncLeaseDurationMs, syncLeaseExtensionMs} from "../../../shared/sync-task-activity"
import {getServerConfig} from "../../utils/config"
import {formatSafeModeTrack, isSafeModeEnabled, logSafeModeCreatePlaylist, logSafeModePlaylistUpdate, playlistAfterChanges, safeModeWriteBlockedMessage} from "./safe-mode"
import {saveMergedPlaylistMappings} from "./playlist-mappings"
import {accountSnapshotPlaylistBatchSize, saveAccountSnapshotBatches} from "./snapshot-batches"
import {commonTracks, reconcileOneWay, reconcileThreeWay, trackKey, type ReconciledTrack} from "./reconcile"

interface RecordedTrackChanges {
    addedTracks?: SyncRunTrackReference[]
    removedTracks?: SyncRunTrackReference[]
    unmatchedTracks?: SyncRunTrackReference[]
}

type RecordTrackChanges = (changes: RecordedTrackChanges) => Promise<void>
type ReportProgress = (progress: SyncRunProgress) => Promise<void>

interface SyncRunContext {
    task: SyncTaskDocument
    taskId: ObjectId
    leaseId: string
    runId: ObjectId
    trigger: "created" | "manual" | "scheduled"
    startedAt: Date
    taskLabel: string
    reverseSync?: ReverseSyncRequest
}

// Renew often enough that a 5-minute extension lands before the previous window lapses.
const syncLeaseHeartbeatMs = 60 * 1000

interface SyncLeaseHold {
    assertHeld(): void
    extend(): Promise<void>
    applyInitial(playlistCount: number): Promise<void>
    stop(): void
}

const syncLeaseHold = new AsyncLocalStorage<SyncLeaseHold>()

// Stop a run that no longer owns its lease before it writes to a provider again.
function assertSyncLeaseHeld() {
    syncLeaseHold.getStore()?.assertHeld()
}

// Move the lease forward by 5 minutes when this run still owns it and the current window is ending.
async function extendSyncLease(taskId: ObjectId, leaseId: string, now = new Date()): Promise<boolean> {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, leaseId}, {projection: {leaseExpiresAt: 1}})
    if (!task) return false
    const next = extendedLeaseExpiry(task.leaseExpiresAt, now)
    if (!next) return true
    const updated = await db.syncTasks.updateOne({_id: taskId, leaseId, leaseExpiresAt: {$lt: next}}, {$set: {leaseExpiresAt: next}})
    if (updated.matchedCount) {
        logger.info("Sync.lease", `Task ${taskId.toHexString()}`, `Extended by ${syncLeaseExtensionMs / 60000}m until ${next.toISOString()}`)
        return true
    }
    const stillOwned = await db.syncTasks.findOne({_id: taskId, leaseId}, {projection: {_id: 1}})
    return Boolean(stillOwned)
}

// Raise a full-sync lease to 15 minutes plus 5 minutes per playlist after the first, without shortening it.
async function applyInitialSyncLease(taskId: ObjectId, leaseId: string, playlistCount: number, now = new Date()): Promise<boolean> {
    const db = await collections()
    const owned = await db.syncTasks.findOne({_id: taskId, leaseId}, {projection: {_id: 1}})
    if (!owned) return false
    const expiresAt = new Date(now.getTime() + initialSyncLeaseMs(playlistCount))
    const updated = await db.syncTasks.updateOne({_id: taskId, leaseId, $or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lt: expiresAt}}]}, {$set: {leaseExpiresAt: expiresAt}})
    if (updated.matchedCount) {
        logger.info("Sync.lease", `Task ${taskId.toHexString()}`, `Initial lease ${initialSyncLeaseMs(playlistCount) / 60000}m`, `Playlists ${playlistCount}`)
        return true
    }
    const stillOwned = await db.syncTasks.findOne({_id: taskId, leaseId}, {projection: {_id: 1}})
    return Boolean(stillOwned)
}

// Keep the lease alive for this run and remember when another run has taken it.
function startSyncLeaseHold(taskId: ObjectId, leaseId: string): SyncLeaseHold {
    let lost = false
    const lose = () => {
        lost = true
    }
    const heartbeat = setInterval(() => {
        void extendSyncLease(taskId, leaseId)
            .then((held) => {
                if (!held) lose()
            })
            .catch((error) => {
                logger.error("Sync.lease", error, `Task ${taskId.toHexString()}`, "Lease extension failed")
            })
    }, syncLeaseHeartbeatMs)
    heartbeat.unref()
    return {
        assertHeld() {
            if (lost) throw createError({statusCode: 409, statusMessage: "Sync lease was lost"})
        },
        async extend() {
            const held = await extendSyncLease(taskId, leaseId)
            if (!held) {
                lose()
                throw createError({statusCode: 409, statusMessage: "Sync lease was lost"})
            }
        },
        async applyInitial(playlistCount: number) {
            const held = await applyInitialSyncLease(taskId, leaseId, playlistCount)
            if (!held) {
                lose()
                throw createError({statusCode: 409, statusMessage: "Sync lease was lost"})
            }
        },
        stop() {
            clearInterval(heartbeat)
        }
    }
}

// Store provider tracks in the snapshot's canonical representation.
function toCanonical(track: ProviderTrack): CanonicalTrack {
    return {
        occurrenceId: track.itemId,
        canonicalKey: trackKey(track),
        isrc: track.isrc,
        title: track.title,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs,
        providerItemId: track.itemId,
        providerTrackId: track.trackId
    }
}

// Convert a snapshot track back into the provider adapter representation.
function fromCanonical(track: CanonicalTrack): ProviderTrack {
    return {
        itemId: track.providerItemId,
        trackId: track.providerTrackId,
        canonicalKey: track.canonicalKey,
        isrc: track.isrc,
        title: track.title,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs
    }
}

// Group current provider occurrences by their matching key.
function countTracks(tracks: ProviderTrack[]): Map<string, ProviderTrack[]> {
    const result = new Map<string, ProviderTrack[]>()
    for (const track of tracks) {
        const key = trackKey(track)
        result.set(key, [...(result.get(key) || []), track])
    }
    return result
}

// Map provider identifiers from a snapshot to canonical track keys.
function aliasMap(items: CanonicalTrack[]): Map<string, string> {
    return new Map(
        items.flatMap((item) => [
            [item.providerItemId, item.canonicalKey],
            [item.providerTrackId, item.canonicalKey]
        ])
    )
}

// Attach snapshot aliases before reconciling fresh provider results.
function applyAliases(tracks: ProviderTrack[], aliases: Map<string, string>): ProviderTrack[] {
    return tracks.map((track) => ({...track, canonicalKey: aliases.get(track.itemId) || aliases.get(track.trackId)}))
}

// Build history references for tracks changed during a sync run.
function trackReferences(account: ProviderAccountDocument, playlistId: string, tracks: Pick<ProviderTrack, "trackId" | "itemId" | "title" | "artists" | "durationMs">[], playlistName: string): SyncRunTrackReference[] {
    return tracks.map((track) => ({
        providerAccountId: account._id!,
        playlistId,
        providerTrackId: track.trackId,
        providerItemId: track.itemId,
        title: track.title,
        artists: track.artists,
        durationMs: track.durationMs,
        playlistName
    }))
}

// Apply additions and removals needed to reach the reconciled playlist state.
async function applyDesired(
    account: ProviderAccountDocument,
    playlistId: string,
    current: ProviderTrack[],
    desired: ReconciledTrack[],
    recordChanges: RecordTrackChanges,
    playlistName: string,
    unmatchedOrigin: {account: ProviderAccountDocument; playlistId: string; playlistName: string}
): Promise<{
    additions: number
    removals: number
    skipped: number
    aliases: {trackId: string; canonicalKey: string}[]
}> {
    const adapter = getProviderAdapter(account.provider)
    const currentByKey = countTracks(current)
    const desiredByKey = new Map(desired.map((track) => [track.key, track]))
    const removedTracks: ProviderTrack[] = []
    const additions: {trackId: string; canonicalKey: string; title: string; artists: string[]; durationMs?: number}[] = []
    const unmatched: ProviderTrack[] = []

    for (const [key, occurrences] of currentByKey) {
        const desiredCount = desiredByKey.get(key)?.count || 0
        removedTracks.push(...occurrences.slice(desiredCount))
    }
    for (const desiredTrack of desired) {
        const missing = desiredTrack.count - (currentByKey.get(desiredTrack.key)?.length || 0)
        for (let count = 0; count < missing; count++) {
            assertSyncLeaseHeld()
            const match = await adapter.searchTrack(account, desiredTrack.reference)
            if (match) {
                additions.push({
                    trackId: match.trackId,
                    canonicalKey: desiredTrack.key,
                    title: match.title,
                    artists: match.artists,
                    durationMs: match.durationMs
                })
            } else {
                unmatched.push(desiredTrack.reference)
            }
        }
    }
    const skipped = unmatched.length
    const removals = removedTracks.map((track) => track.itemId)
    if (additions.length || removals.length || skipped) {
        logger.info("Sync.applyDesired", account.provider, `Playlist ${playlistId}`, playlistName, `Additions ${additions.length}`, `Removals ${removals.length}`, `Unmatched ${skipped}`)
    }
    // PLS_SAFE_MODE logs the planned membership and leaves music providers untouched.
    if (isSafeModeEnabled()) {
        logSafeModePlaylistUpdate({
            provider: account.provider,
            playlistId,
            playlistName,
            removals: removedTracks,
            additions,
            unmatched,
            finalTracks: playlistAfterChanges(
                current,
                removals,
                additions.map((item) => ({itemId: item.trackId, trackId: item.trackId, title: item.title, artists: item.artists}))
            )
        })
        return {additions: additions.length, removals: removals.length, skipped, aliases: additions}
    }
    assertSyncLeaseHeld()
    if (removals.length) {
        await adapter.removePlaylistItems(account, playlistId, removals, async (removedItemIds) => {
            const removedIds = new Set(removedItemIds)
            await recordChanges({
                removedTracks: trackReferences(
                    account,
                    playlistId,
                    current.filter((track) => removedIds.has(track.itemId)),
                    playlistName
                )
            })
        })
    }
    assertSyncLeaseHeld()
    if (additions.length) {
        await adapter.addTracks(
            account,
            playlistId,
            additions.map((item) => item.trackId),
            async (addedTracks) => {
                const known = new Map(additions.map((item) => [item.trackId, item]))
                await recordChanges({
                    addedTracks: addedTracks.map((track) => {
                        const match = known.get(track.providerTrackId)
                        if (!match) {
                            logger.warn("Sync.execute", account.provider, `Track ${track.providerTrackId}`, "Added track metadata was not found")
                        }
                        return {
                            providerAccountId: account._id!,
                            playlistId,
                            providerTrackId: track.providerTrackId,
                            providerItemId: track.providerItemId,
                            title: match?.title || "Unknown track",
                            artists: match?.artists || [],
                            durationMs: match?.durationMs,
                            playlistName
                        }
                    })
                })
            }
        )
    }
    if (unmatched.length) {
        await recordChanges({
            unmatchedTracks: trackReferences(unmatchedOrigin.account, unmatchedOrigin.playlistId, unmatched, unmatchedOrigin.playlistName)
        })
    }
    return {additions: additions.length, removals: removals.length, skipped, aliases: additions}
}

// Keep destination tracks that a reverse restore could not copy, so the next mirror does not delete them.
function preserveRestoredTracks(desired: ReconciledTrack[], current: ProviderTrack[], preserved: SyncRunTrackReference[]): ReconciledTrack[] {
    if (!preserved.length) {
        return desired
    }
    const next = desired.map((track) => ({...track}))
    const byKey = new Map(next.map((track) => [track.key, track]))
    for (const track of current) {
        const kept = preserved.some((item) => item.providerTrackId === track.trackId || (item.providerItemId && item.providerItemId === track.itemId))
        if (!kept) {
            continue
        }
        const key = trackKey(track)
        const currentCount = current.filter((item) => trackKey(item) === key).length
        const existing = byKey.get(key)
        if (existing) {
            existing.count = Math.max(existing.count, currentCount)
            continue
        }
        const addition = {key, count: currentCount, reference: track}
        next.push(addition)
        byKey.set(key, addition)
    }
    return next
}

// Unmatched tracks from the latest completed reverse sync still have to stay on the destination.
async function restoredTracksToKeep(taskId: ObjectId): Promise<SyncRunTrackReference[]> {
    const db = await collections()
    const runs = await db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(20).toArray()
    const restore = runs.find((run) => run.reverseSync && (run.status === "succeeded" || run.status === "partial"))
    return restore?.unmatchedTracks || []
}

// Load a provider account while enforcing ownership.
async function loadAccount(id: ObjectId, userId: ObjectId): Promise<ProviderAccountDocument> {
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: id, userId})
    if (!account) {
        throw createError({statusCode: 409, statusMessage: "A connected provider account is missing"})
    }
    return account
}

type PlaylistRead = {missing: true} | {missing: false; items: ProviderTrack[]}

// Read a playlist, treating a provider 404 as a missing playlist instead of an unknown failure.
async function readPlaylistItems(account: ProviderAccountDocument, playlistId: string): Promise<PlaylistRead> {
    try {
        return {missing: false, items: await getProviderAdapter(account.provider).getPlaylistItems(account, playlistId)}
    } catch (error) {
        if (isMissingPlaylistError(error)) {
            return {missing: true}
        }
        throw error
    }
}

// Keep the provider's 404 text and, for a deleted source, mark the run so restore can be offered.
function missingPlaylistError(provider: string, failureReason?: SyncFailureReason) {
    return createError({
        statusCode: 502,
        statusMessage: `${provider} API request failed (404)`,
        ...(failureReason ? {data: {failureReason}} : {})
    })
}

// Describe a task's source and destination provider and playlist for log lines.
async function describeTask(task: SyncTaskDocument): Promise<string> {
    const db = await collections()
    const [sourceAccount, destinationAccount] = await Promise.all([
        db.providerAccounts.findOne({_id: task.source.providerAccountId}, {projection: {provider: 1}}),
        db.providerAccounts.findOne({_id: task.destination.providerAccountId}, {projection: {provider: 1}})
    ])
    return `${sourceAccount?.provider ?? "?"} "${task.source.name}" -> ${destinationAccount?.provider ?? "?"} "${task.destination.name}"`
}

// Reconcile one playlist pair and refresh its matching snapshot.
async function executePlaylist(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress) {
    const db = await collections()
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourceRead, destinationRead, snapshot] = await Promise.all([readPlaylistItems(sourceAccount, task.source.playlistId), readPlaylistItems(destinationAccount, task.destination.playlistId), db.syncSnapshots.findOne({taskId: task._id!})])
    if (sourceRead.missing || destinationRead.missing) {
        // Only a missing source, with the target still readable, can be restored from that target.
        if (sourceRead.missing && !destinationRead.missing) {
            throw missingPlaylistError(sourceAccount.provider, "deleted-source")
        }
        throw missingPlaylistError((sourceRead.missing ? sourceAccount : destinationAccount).provider)
    }
    const sourceItems = sourceRead.items
    const destinationItems = destinationRead.items
    await reportProgress({tracksTotal: Math.max(sourceItems.length, destinationItems.length)})
    const oneWay = task.direction === "one-way"
    logger.info(
        "Sync.execute",
        `Task ${task._id!.toHexString()}`,
        `${sourceAccount.provider} items ${sourceItems.length}`,
        `${destinationAccount.provider} items ${destinationItems.length}`,
        snapshot ? (oneWay ? "Mirror run" : "Reconciliation run") : "Initial run"
    )

    let sourceResult = {additions: 0, removals: 0, skipped: 0, aliases: [] as {trackId: string; canonicalKey: string}[]}
    let destinationResult = {
        additions: 0,
        removals: 0,
        skipped: 0,
        aliases: [] as {trackId: string; canonicalKey: string}[]
    }
    let conflicts: string[] = []
    if (!snapshot) {
        if (!oneWay) {
            // First two-way runs baseline both sides so destination-only tracks survive the initial reconciliation.
            const baseline = commonTracks(sourceItems, destinationItems)
            const reconciliation = reconcileThreeWay(baseline, sourceItems, destinationItems)
            conflicts = reconciliation.conflicts
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, destinationItems, reconciliation.desired, recordChanges, task.destination.name, {
                account: sourceAccount,
                playlistId: task.source.playlistId,
                playlistName: task.source.name
            })
            sourceResult = await applyDesired(sourceAccount, task.source.playlistId, sourceItems, reconciliation.desired, recordChanges, task.source.name, {
                account: destinationAccount,
                playlistId: task.destination.playlistId,
                playlistName: task.destination.name
            })
        } else {
            const desired = reconcileOneWay(sourceItems).desired
            if (destinationItems.length && isSafeModeEnabled()) {
                for (const track of destinationItems) {
                    logger.info("Sync.safeMode", destinationAccount.provider, `Playlist ${task.destination.playlistId}`, "Would remove", formatSafeModeTrack(track))
                }
            } else if (destinationItems.length) {
                const byItemId = new Map(destinationItems.map((track) => [track.itemId, track]))
                await destinationAdapter.removePlaylistItems(
                    destinationAccount,
                    task.destination.playlistId,
                    destinationItems.map((track) => track.itemId),
                    async (removedItemIds) => {
                        await recordChanges({
                            removedTracks: trackReferences(
                                destinationAccount,
                                task.destination.playlistId,
                                removedItemIds.flatMap((itemId) => {
                                    const track = byItemId.get(itemId)
                                    return track ? [track] : []
                                }),
                                task.destination.name
                            )
                        })
                    }
                )
            }
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, [], desired, recordChanges, task.destination.name, {account: sourceAccount, playlistId: task.source.playlistId, playlistName: task.source.name})
            destinationResult.removals = destinationItems.length
        }
    } else {
        const sourceAliases = aliasMap(snapshot.sourceItems)
        const destinationAliases = aliasMap(snapshot.destinationItems)
        const aliasedSource = applyAliases(sourceItems, sourceAliases)
        const aliasedDestination = applyAliases(destinationItems, destinationAliases)
        if (oneWay) {
            const desired = preserveRestoredTracks(reconcileOneWay(aliasedSource).desired, aliasedDestination, await restoredTracksToKeep(task._id!))
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, aliasedDestination, desired, recordChanges, task.destination.name, {
                account: sourceAccount,
                playlistId: task.source.playlistId,
                playlistName: task.source.name
            })
        } else {
            const baseline = commonTracks(snapshot.sourceItems.map(fromCanonical), snapshot.destinationItems.map(fromCanonical))
            const reconciliation = reconcileThreeWay(baseline, aliasedSource, aliasedDestination)
            conflicts = reconciliation.conflicts
            if (conflicts.length) {
                logger.warn("Sync.reconcile", `Task ${task._id!.toHexString()}`, `Conflicts ${conflicts.length}`)
            }
            sourceResult = await applyDesired(sourceAccount, task.source.playlistId, aliasedSource, reconciliation.desired, recordChanges, task.source.name, {
                account: destinationAccount,
                playlistId: task.destination.playlistId,
                playlistName: task.destination.name
            })
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, aliasedDestination, reconciliation.desired, recordChanges, task.destination.name, {
                account: sourceAccount,
                playlistId: task.source.playlistId,
                playlistName: task.source.name
            })
        }
    }

    if (isSafeModeEnabled()) {
        logger.info("Sync.safeMode", `Task ${task._id!.toHexString()}`, "Skipping snapshot update")
    } else {
        const [verifiedSourceRead, verifiedDestinationRead] = await Promise.all([readPlaylistItems(sourceAccount, task.source.playlistId), readPlaylistItems(destinationAccount, task.destination.playlistId)])
        if (verifiedSourceRead.missing || verifiedDestinationRead.missing) {
            if (verifiedSourceRead.missing && !verifiedDestinationRead.missing) {
                throw missingPlaylistError(sourceAccount.provider, "deleted-source")
            }
            throw missingPlaylistError((verifiedSourceRead.missing ? sourceAccount : destinationAccount).provider)
        }
        const verifiedSource = verifiedSourceRead.items
        const verifiedDestination = verifiedDestinationRead.items
        const desiredAliases = new Map<string, string>([
            ...(snapshot ? [...aliasMap(snapshot.sourceItems), ...aliasMap(snapshot.destinationItems)] : []),
            ...sourceResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const),
            ...destinationResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const)
        ])
        const normalizedAliases = new Map([...countTracks(sourceItems)].map(([key, occurrences]) => [trackKey(occurrences[0]!), key] as const))
        const canonicalize = (items: ProviderTrack[]) =>
            items.map((item) => ({
                ...item,
                canonicalKey: desiredAliases.get(item.itemId) || desiredAliases.get(item.trackId) || normalizedAliases.get(trackKey(item))
            }))
        await db.syncSnapshots.updateOne(
            {taskId: task._id!},
            {
                $set: {
                    sourceItems: canonicalize(verifiedSource).map(toCanonical),
                    destinationItems: canonicalize(verifiedDestination).map(toCanonical),
                    createdAt: new Date()
                }
            },
            {upsert: true}
        )
    }
    return {
        additions: sourceResult.additions + destinationResult.additions,
        removals: sourceResult.removals + destinationResult.removals,
        skipped: sourceResult.skipped + destinationResult.skipped,
        conflicts: conflicts.length
    }
}

// Mirror one source playlist into its mapped destination playlist.
async function mirrorPlaylist(
    sourceAccount: ProviderAccountDocument,
    destinationAccount: ProviderAccountDocument,
    sourcePlaylistId: string,
    destinationPlaylistId: string,
    playlistName: string,
    recordChanges: RecordTrackChanges,
    manualAliases: PlaylistMapping["manualAliases"] = []
) {
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourceItems, destinationItems] = await Promise.all([sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylistId), destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylistId)])
    const aliases = new Map<string, string>()
    for (const alias of manualAliases || []) {
        aliases.set(alias.sourceTrackId, alias.canonicalKey)
        if (alias.sourceItemId) aliases.set(alias.sourceItemId, alias.canonicalKey)
        aliases.set(alias.destinationTrackId, alias.canonicalKey)
        if (alias.destinationItemId) aliases.set(alias.destinationItemId, alias.canonicalKey)
    }
    const aliasedSource = aliases.size ? applyAliases(sourceItems, aliases) : sourceItems
    const aliasedDestination = aliases.size ? applyAliases(destinationItems, aliases) : destinationItems
    const result = await applyDesired(destinationAccount, destinationPlaylistId, aliasedDestination, reconcileOneWay(aliasedSource).desired, recordChanges, playlistName, {account: sourceAccount, playlistId: sourcePlaylistId, playlistName})
    const verifiedAliases = new Map(aliases)
    for (const alias of result.aliases) verifiedAliases.set(alias.trackId, alias.canonicalKey)
    const withKey = (items: ProviderTrack[]) => items.map((item) => ({...item, canonicalKey: verifiedAliases.get(item.itemId) || verifiedAliases.get(item.trackId) || item.canonicalKey || trackKey(item)}))
    const [verifiedSource, verifiedDestination] = isSafeModeEnabled()
        ? [aliasedSource, aliasedDestination]
        : await Promise.all([sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylistId), destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylistId)])
    return {
        ...result,
        snapshotPlaylist: {
            sourcePlaylistId,
            destinationPlaylistId,
            name: playlistName,
            sourceItems: withKey(verifiedSource).map(toCanonical),
            destinationItems: withKey(verifiedDestination).map(toCanonical)
        }
    }
}

// Synchronize every source playlist and maintain destination mappings.
async function executeAccount(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress) {
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourcePlaylists, destinationPlaylists] = await Promise.all([sourceAdapter.listPlaylists(sourceAccount), destinationAdapter.listPlaylists(destinationAccount)])
    const destinationById = new Map(destinationPlaylists.map((playlist) => [playlist.id, playlist]))
    const mappings: PlaylistMapping[] = [...(task.playlistMappings || [])]
    const claimedDestinationIds = new Set(mappings.map((mapping) => mapping.destinationPlaylistId))
    // Re-read aliases at save time so a manual match is not replaced by this older copy.
    const persistMappings = () => saveMergedPlaylistMappings(task._id!, mappings)
    let additions = 0
    let removals = 0
    let skipped = 0
    let playlistsCompleted = 0
    const snapshotPlaylists = []
    await syncLeaseHold.getStore()?.applyInitial(sourcePlaylists.length)
    await reportProgress({playlistsTotal: sourcePlaylists.length, playlistsCompleted: 0})

    for (const sourcePlaylist of sourcePlaylists) {
        assertSyncLeaseHeld()
        let mapping = mappings.find((item) => item.sourcePlaylistId === sourcePlaylist.id)
        let destinationPlaylist: ProviderPlaylist | undefined = mapping ? destinationById.get(mapping.destinationPlaylistId) : undefined
        if (!destinationPlaylist) {
            destinationPlaylist = destinationPlaylists.find((playlist) => playlist.name === sourcePlaylist.name && !claimedDestinationIds.has(playlist.id))
        }
        if (!destinationPlaylist) {
            if (isSafeModeEnabled()) {
                logSafeModeCreatePlaylist(destinationAccount.provider, sourcePlaylist.name)
                const sourceItems = await sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylist.id)
                const result = await applyDesired(destinationAccount, `(new) ${sourcePlaylist.name}`, [], reconcileOneWay(sourceItems).desired, recordChanges, sourcePlaylist.name, {
                    account: sourceAccount,
                    playlistId: sourcePlaylist.id,
                    playlistName: sourcePlaylist.name
                })
                additions += result.additions
                removals += result.removals
                skipped += result.skipped
                playlistsCompleted += 1
                await reportProgress({playlistsTotal: sourcePlaylists.length, playlistsCompleted})
                continue
            }
            destinationPlaylist = await destinationAdapter.createPlaylist(destinationAccount, sourcePlaylist.name, sourcePlaylist.description)
            destinationPlaylists.push(destinationPlaylist)
            destinationById.set(destinationPlaylist.id, destinationPlaylist)
        }
        claimedDestinationIds.add(destinationPlaylist.id)
        if (!mapping) {
            mapping = {
                sourcePlaylistId: sourcePlaylist.id,
                destinationPlaylistId: destinationPlaylist.id,
                name: sourcePlaylist.name
            }
            mappings.push(mapping)
            await persistMappings()
        } else if (mapping.destinationPlaylistId !== destinationPlaylist.id || mapping.name !== sourcePlaylist.name) {
            mapping.destinationPlaylistId = destinationPlaylist.id
            mapping.name = sourcePlaylist.name
            await persistMappings()
        }
        const result = await mirrorPlaylist(sourceAccount, destinationAccount, sourcePlaylist.id, destinationPlaylist.id, mapping.name, recordChanges, mapping.manualAliases)
        additions += result.additions
        removals += result.removals
        skipped += result.skipped
        snapshotPlaylists.push(result.snapshotPlaylist)
        playlistsCompleted += 1
        await reportProgress({playlistsTotal: sourcePlaylists.length, playlistsCompleted})
    }

    if (!isSafeModeEnabled()) {
        await saveAccountSnapshotBatches(task._id!, snapshotPlaylists)
    }
    logger.info(
        "Sync.executeAccount",
        `Task ${task._id!.toHexString()}`,
        `Playlists ${sourcePlaylists.length}`,
        `Snapshot batches ${Math.ceil(snapshotPlaylists.length / accountSnapshotPlaylistBatchSize)}`,
        `Additions ${additions}`,
        `Removals ${removals}`,
        `Unmatched ${skipped}`
    )
    return {additions, removals, skipped, conflicts: 0}
}

// Remove a playlist created for a restore that did not finish, so a retry can start again.
async function discardCreatedPlaylist(account: ProviderAccountDocument, playlistId: string) {
    try {
        await getProviderAdapter(account.provider).deletePlaylist(account, playlistId)
    } catch (error) {
        logger.error("Sync.reverse", account.provider, `Playlist ${playlistId}`, "Created playlist could not be removed", error)
    }
}

// Copy one playlist onto the other in the case's direction. A deleted target is recreated only when the case asks for that.
async function copyPlaylistOnce(task: SyncTaskDocument, recordChanges: RecordTrackChanges, syncCase: ReverseSyncCase) {
    const db = await collections()
    const reverse = syncCase.direction === "reverse"
    const fromRef = reverse ? task.destination : task.source
    const toRef = reverse ? task.source : task.destination
    const fromAccount = await loadAccount(fromRef.providerAccountId, task.userId)
    const toAccount = await loadAccount(toRef.providerAccountId, task.userId)
    const fromRead = await readPlaylistItems(fromAccount, fromRef.playlistId)
    if (fromRead.missing) {
        throw createError({statusCode: 409, statusMessage: "The playlist to copy from is missing"})
    }
    const toRead = await readPlaylistItems(toAccount, toRef.playlistId)
    let toPlaylistId = toRef.playlistId
    let toItems: ProviderTrack[] = []
    let createdPlaylistId: string | undefined
    let committed = false
    try {
        if (toRead.missing) {
            if (!syncCase.recreateTarget) {
                throw missingPlaylistError(toAccount.provider)
            }
            if (isSafeModeEnabled()) {
                logSafeModeCreatePlaylist(toAccount.provider, toRef.name)
                throw createError({statusCode: 503, statusMessage: safeModeWriteBlockedMessage})
            }
            const created = await getProviderAdapter(toAccount.provider).createPlaylist(toAccount, toRef.name)
            createdPlaylistId = created.id
            toPlaylistId = created.id
            logger.info("Sync.reverse", `Task ${task._id!.toHexString()}`, syncCase.reason, toAccount.provider, `Created playlist ${created.id}`)
        } else if (syncCase.recreateTarget) {
            throw createError({statusCode: 409, statusMessage: "The playlist to restore is already there"})
        } else {
            toItems = toRead.items
        }
        const result = await applyDesired(toAccount, toPlaylistId, toItems, reconcileOneWay(fromRead.items).desired, recordChanges, toRef.name, {
            account: fromAccount,
            playlistId: fromRef.playlistId,
            playlistName: fromRef.name
        })
        if (!isSafeModeEnabled()) {
            const [verifiedFromRead, verifiedToRead] = await Promise.all([readPlaylistItems(fromAccount, fromRef.playlistId), readPlaylistItems(toAccount, toPlaylistId)])
            if (verifiedFromRead.missing || verifiedToRead.missing) {
                throw missingPlaylistError((verifiedToRead.missing ? toAccount : fromAccount).provider)
            }
            const verifiedFrom = verifiedFromRead.items
            const verifiedTo = verifiedToRead.items
            const aliases = new Map(result.aliases.map((item) => [item.trackId, item.canonicalKey]))
            const withAliases = (items: ProviderTrack[]) => items.map((item) => ({...item, canonicalKey: aliases.get(item.itemId) || aliases.get(item.trackId) || item.canonicalKey}))
            const sourceItems = reverse ? withAliases(verifiedTo) : verifiedFrom
            const destinationItems = reverse ? verifiedFrom : withAliases(verifiedTo)
            await db.syncSnapshots.updateOne({taskId: task._id!}, {$set: {sourceItems: sourceItems.map(toCanonical), destinationItems: destinationItems.map(toCanonical), createdAt: new Date()}}, {upsert: true})
            if (createdPlaylistId) {
                if (reverse) {
                    task.source = {...task.source, playlistId: createdPlaylistId}
                } else {
                    task.destination = {...task.destination, playlistId: createdPlaylistId}
                }
                await db.syncTasks.updateOne({_id: task._id}, {$set: {source: task.source, destination: task.destination, updatedAt: new Date()}})
                committed = true
            }
        }
        logger.info("Sync.reverse", `Task ${task._id!.toHexString()}`, syncCase.reason, syncCase.direction, syncCase.cadence, `Additions ${result.additions}`, `Removals ${result.removals}`, `Unmatched ${result.skipped}`)
        return {additions: result.additions, removals: result.removals, skipped: result.skipped, conflicts: 0}
    } catch (error) {
        if (createdPlaylistId && !committed) {
            await discardCreatedPlaylist(toAccount, createdPlaylistId)
        }
        throw error
    }
}

// Run one registered reverse sync without changing the task's usual direction.
async function executeReverseSync(task: SyncTaskDocument, recordChanges: RecordTrackChanges, request: ReverseSyncRequest) {
    const syncCase = reverseSyncCaseFor(request)
    if (!syncCase) {
        throw createError({statusCode: 400, statusMessage: "This reverse sync is not available"})
    }
    if (task.mode !== "playlist") {
        throw createError({statusCode: 409, statusMessage: "Reverse sync is only available for a playlist pair"})
    }
    // One-time cases copy once. An ongoing case needs its own schedule before it can run.
    if (syncCase.cadence !== "one-time") {
        throw createError({statusCode: 400, statusMessage: "Ongoing reverse sync is not available yet"})
    }
    return copyPlaylistOnce(task, recordChanges, syncCase)
}

// Dispatch a task to playlist, account, or a registered reverse synchronization.
async function execute(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress, reverseSync?: ReverseSyncRequest) {
    if (reverseSync) {
        return executeReverseSync(task, recordChanges, reverseSync)
    }
    return task.mode === "account" ? executeAccount(task, recordChanges, reportProgress) : executePlaylist(task, recordChanges, reportProgress)
}

// Acquire a lease and create a running sync record before work starts.
export async function beginSyncTask(taskId: ObjectId, trigger: "created" | "manual" | "scheduled", reverseSync?: ReverseSyncRequest): Promise<SyncRunContext> {
    const db = await collections()
    const current = await db.syncTasks.findOne({_id: taskId})
    if (current) {
        const owner = await db.users.findOne({_id: current.userId})
        if (owner) {
            await applyTaskEntitlement(owner)
        }
    }
    const leaseId = randomUUID()
    const now = new Date()
    const taskLabel = current ? await describeTask(current) : ""
    if (isSafeModeEnabled()) {
        logger.warn("Sync.safeMode", `Task ${taskId.toHexString()}`, `Trigger ${trigger}`, "PLS_SAFE_MODE is enabled; music providers will not be written")
    }
    logger.info("Sync.run", `Task ${taskId.toHexString()}`, taskLabel, `Trigger ${trigger}`, ...(reverseSync ? [reverseSync.direction, reverseSync.cadence, reverseSync.reason] : []), `Lease ${syncLeaseDurationMs / 60000}m`)
    const task = await db.syncTasks.findOneAndUpdate(
        {
            _id: taskId,
            status: {$in: ["active", "needs_attention"]},
            $or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lt: now}}]
        },
        {$set: {leaseId, leaseExpiresAt: new Date(now.getTime() + syncLeaseDurationMs)}},
        {returnDocument: "after"}
    )
    if (!task) {
        logger.warn("Sync.run", `Task ${taskId.toHexString()}`, taskLabel, "Task is paused, missing, or already leased")
        throw createError({statusCode: 409, statusMessage: "Task is paused or already running"})
    }
    const run = await db.syncRuns.insertOne({
        taskId,
        trigger,
        status: "running",
        additions: 0,
        removals: 0,
        conflicts: 0,
        skipped: 0,
        addedTracks: [],
        removedTracks: [],
        unmatchedTracks: [],
        ...(reverseSync ? {reverseSync} : {}),
        progress: {},
        startedAt: now
    })
    logger.info("Sync.run", `Task ${taskId.toHexString()}`, taskLabel, `Run ${run.insertedId.toHexString()}`, "Started")
    return {task, taskId, leaseId, runId: run.insertedId, trigger, startedAt: now, taskLabel, ...(reverseSync ? {reverseSync} : {})}
}

// Execute a prepared run and persist its final outcome.
export async function completeSyncTask(context: SyncRunContext) {
    const db = await collections()
    const {task, taskId, leaseId, runId, startedAt, taskLabel, reverseSync} = context
    const recordChanges: RecordTrackChanges = async ({addedTracks = [], removedTracks = [], unmatchedTracks = []}) => {
        if (addedTracks.length) {
            await db.syncRuns.updateOne({_id: runId}, {$push: {addedTracks: {$each: addedTracks}}, $inc: {additions: addedTracks.length}})
        }
        if (removedTracks.length) {
            await db.syncRuns.updateOne({_id: runId}, {$push: {removedTracks: {$each: removedTracks}}, $inc: {removals: removedTracks.length}})
        }
        if (unmatchedTracks.length) {
            await db.syncRuns.updateOne({_id: runId}, {$push: {unmatchedTracks: {$each: unmatchedTracks}}})
        }
    }
    const reportProgress: ReportProgress = async (progress) => {
        assertSyncLeaseHeld()
        await db.syncRuns.updateOne({_id: runId}, {$set: {progress}})
        await syncLeaseHold.getStore()?.extend()
    }
    const leaseHold = startSyncLeaseHold(taskId, leaseId)
    try {
        const result = await syncLeaseHold.run(leaseHold, async () => execute(task, recordChanges, reportProgress, reverseSync))
        const user = await db.users.findOne({_id: task.userId})
        const proIntervalMs = proSyncIntervalMs(getServerConfig().proSyncIntervalMinutes)
        const nextRunMs = user && resolveEntitlement(user).tier === "pro" ? proIntervalMs : 7 * 24 * 60 * 60 * 1000
        const finishedAt = new Date()
        const completed = await db.syncTasks.updateOne(
            {_id: taskId, leaseId, pauseReason: {$ne: "entitlement"}},
            {
                $set: {
                    status: result.conflicts ? "needs_attention" : "active",
                    lastRunAt: finishedAt,
                    lastSuccessAt: finishedAt,
                    nextRunAt: new Date(finishedAt.getTime() + nextRunMs),
                    updatedAt: finishedAt
                },
                $unset: {leaseId: "", leaseExpiresAt: "", lastError: ""}
            }
        )
        await db.syncRuns.updateOne({_id: runId}, {$set: {...result, status: result.skipped || result.conflicts ? "partial" : "succeeded", finishedAt}, $unset: {progress: ""}})
        if (!completed.matchedCount) {
            // Release only the lease this run still holds. A newer run's lease stays in place.
            const released = await db.syncTasks.updateOne(
                {_id: taskId, leaseId},
                {
                    $set: {lastRunAt: finishedAt, lastSuccessAt: finishedAt, updatedAt: finishedAt},
                    $unset: {leaseId: "", leaseExpiresAt: "", lastError: ""}
                }
            )
            if (!released.matchedCount) {
                logger.warn("Sync.lease", `Task ${taskId.toHexString()}`, "Lease was no longer held; task lock was left unchanged")
            }
        }
        const log = result.skipped || result.conflicts ? logger.warn : logger.info
        log(
            "Sync.run",
            `Task ${taskId.toHexString()}`,
            taskLabel,
            `Run ${runId.toHexString()}`,
            `Additions ${result.additions}`,
            `Removals ${result.removals}`,
            `Conflicts ${result.conflicts}`,
            `Unmatched ${result.skipped}`,
            `Duration ${finishedAt.getTime() - startedAt.getTime()}ms`
        )
        return result
    } catch (error) {
        const finishedAt = new Date()
        const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown synchronization error"
        const failureReason = readSyncFailureReason(error)
        const failed = await db.syncTasks.updateOne(
            {_id: taskId, leaseId},
            {
                $set: {lastRunAt: finishedAt, lastError: message, updatedAt: finishedAt},
                $unset: {leaseId: "", leaseExpiresAt: ""}
            }
        )
        await db.syncRuns.updateOne({_id: runId}, {$set: {status: "failed", error: message, finishedAt, ...(failureReason ? {failureReason} : {})}, $unset: {progress: ""}})
        if (!failed.matchedCount) {
            logger.warn("Sync.lease", `Task ${taskId.toHexString()}`, "Lease was no longer held; task lock was left unchanged")
        }
        logger.error("Sync.run", `Task ${taskId.toHexString()}`, taskLabel, `Run ${runId.toHexString()}`, `Duration ${finishedAt.getTime() - startedAt.getTime()}ms`, error)
        throw error
    } finally {
        leaseHold.stop()
    }
}

// Acquire a lease, execute one task, and persist its run outcome.
export async function runSyncTask(taskId: ObjectId, trigger: "created" | "manual" | "scheduled") {
    const context = await beginSyncTask(taskId, trigger)
    return completeSyncTask(context)
}

// Start a registered reverse sync when that case still applies to the task's runs.
export async function runReverseSync(taskId: ObjectId, request: ReverseSyncRequest) {
    const db = await collections()
    const runs = await db.syncRuns.find({taskId}).sort({startedAt: -1}).limit(50).toArray()
    assertReverseSyncAvailable(runs, request)
    logger.info("Sync.reverse", `Task ${taskId.toHexString()}`, request.reason, request.direction, request.cadence)
    const context = await beginSyncTask(taskId, "manual", request)
    return completeSyncTask(context)
}
