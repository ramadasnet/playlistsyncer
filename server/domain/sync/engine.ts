// Execute playlist and account synchronization while recording resumable runs.
import {AsyncLocalStorage} from "node:async_hooks"
import {randomUUID} from "node:crypto"
import {clearInterval, setInterval} from "node:timers"
import {ObjectId} from "mongodb"
import {
    providerDisplayNames,
    type AccountSnapshotPlaylist,
    type CanonicalTrack,
    type PlaylistMapping,
    type ProviderAccountDocument,
    type SyncRunPlaylistIssue,
    type SyncRunProgress,
    type SyncRunTrackReference,
    type SyncSnapshotDocument,
    type SyncTaskDocument
} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {resolveEntitlement} from "../billing/entitlement"
import {applyTaskEntitlement} from "../billing/task-entitlement"
import {isMissingPlaylistError, isQuotaExceededError, nextQuotaResetAt} from "../providers/http"
import {findBestTrackMatch} from "../providers/matching"
import {getAccountAdapter, type ProviderPlaylist, type ProviderTrack} from "../providers"
import {readSyncFailureReason, reverseSyncCaseFor, type ReverseSyncCase, type ReverseSyncRequest, type SyncFailureReason} from "../../../shared/reverse-sync"
import {assertReverseSyncAvailable} from "./reverse-sync"
import {proSyncIntervalMs} from "~~/shared/sync-cadence"
import {extendedLeaseExpiry, leaseIsActive, syncLeaseDurationMs, syncLeaseExtensionMs} from "../../../shared/sync-task-activity"
import {getServerConfig} from "../../utils/config"
import {formatSafeModeTrack, isSafeModeEnabled, logSafeModeCreatePlaylist, logSafeModePlaylistUpdate, playlistAfterChanges, safeModeWriteBlockedMessage} from "./safe-mode"
import {saveMergedPlaylistMappings} from "./playlist-mappings"
import {accountSnapshotPlaylistBatchSize, loadTaskSnapshots, saveAccountSnapshotBatches} from "./snapshot-batches"
import {commonTracks, reconcileOneWay, reconcileThreeWay, shareRecordingKeys, trackKey, type ReconciledTrack} from "./reconcile"
import {storedPlaylistWriteKeys, writtenPlaylistRefs} from "./playlist-writes"

interface RecordedTrackChanges {
    addedTracks?: SyncRunTrackReference[]
    removedTracks?: SyncRunTrackReference[]
    unmatchedTracks?: SyncRunTrackReference[]
    failedPlaylists?: SyncRunPlaylistIssue[]
    missingSourcePlaylists?: SyncRunPlaylistIssue[]
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

// Renew often enough that a 5-minute extension lands before the previous window lapses. Tests shorten this.
export const syncLeaseHeartbeat = {intervalMs: 60 * 1000}

interface SyncLeaseHold {
    assertHeld(): void
    extend(): Promise<void>
    stop(): void
}

const syncLeaseHold = new AsyncLocalStorage<SyncLeaseHold>()
const syncLeaseLostMessage = "Sync lease was lost"

// True when this run stopped because another run took its lease.
function isSyncLeaseLostError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as {statusMessage?: unknown}).statusMessage === syncLeaseLostMessage)
}

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
    }, syncLeaseHeartbeat.intervalMs)
    heartbeat.unref()
    return {
        assertHeld() {
            if (lost) throw createError({statusCode: 409, statusMessage: syncLeaseLostMessage})
        },
        async extend() {
            const held = await extendSyncLease(taskId, leaseId)
            if (!held) {
                lose()
                throw createError({statusCode: 409, statusMessage: syncLeaseLostMessage})
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

// An unavailable entry counts only while a snapshot alias still says which song it was, so it is not read as a removal.
function withoutUnknownUnavailable(tracks: ProviderTrack[]): ProviderTrack[] {
    return tracks.filter((track) => !track.unavailable || track.canonicalKey)
}

// Give new destination tracks the key of a new source track they match, so a title that differs between providers is not read as another song.
function pairMatchingTracks(source: ProviderTrack[], destination: ProviderTrack[], knownKeys: ReadonlySet<string> = new Set()): ProviderTrack[] {
    const sourceKeys = new Set(source.map((track) => trackKey(track)))
    const destinationKeys = new Set(destination.map((track) => trackKey(track)))
    const candidates = new Set(destination.filter((track) => !track.unavailable && !sourceKeys.has(trackKey(track)) && !knownKeys.has(trackKey(track))))
    if (!candidates.size) return destination
    const paired = new Map<ProviderTrack, string>()
    for (const track of source) {
        const key = trackKey(track)
        if (track.unavailable || destinationKeys.has(key) || knownKeys.has(key)) continue
        const match = findBestTrackMatch(track, [...candidates])
        if (match) {
            paired.set(match, key)
            candidates.delete(match)
        }
    }
    return destination.map((track) => (paired.has(track) ? {...track, canonicalKey: paired.get(track)} : track))
}

// Keys the snapshot holds on both sides. A key only one side had, such as an unmatched track, can still pair with a copy an interrupted run added.
function matchedSnapshotKeys(sourceItems: CanonicalTrack[], destinationItems: CanonicalTrack[]): Set<string> {
    const destinationKeys = new Set(destinationItems.map((item) => item.canonicalKey))
    return new Set(sourceItems.map((item) => item.canonicalKey).filter((key) => destinationKeys.has(key)))
}

// Item and track id aliases for destination tracks that were paired with a source track.
function pairedAliases(tracks: ProviderTrack[]): [string, string][] {
    return tracks.flatMap((track) =>
        track.canonicalKey && !track.unavailable
            ? [
                  [track.itemId, track.canonicalKey],
                  [track.trackId, track.canonicalKey]
              ]
            : []
    )
}

// Searches that found nothing are skipped for a week, which keeps unmatched tracks from using up YouTube's daily quota.
const searchMissTtlMs = 7 * 24 * 60 * 60 * 1000

async function loadSearchMisses(account: ProviderAccountDocument): Promise<Set<string>> {
    const db = await collections()
    const misses = await db.searchMisses.find({providerAccountId: account._id!, expiresAt: {$gt: new Date()}}).toArray()
    return new Set(misses.map((miss) => miss.key))
}

async function saveSearchMisses(account: ProviderAccountDocument, keys: string[]) {
    const unique = [...new Set(keys)]
    if (!unique.length || !account._id) return
    const db = await collections()
    const expiresAt = new Date(Date.now() + searchMissTtlMs)
    await db.searchMisses.bulkWrite(unique.map((key) => ({updateOne: {filter: {providerAccountId: account._id!, key}, update: {$set: {expiresAt}}, upsert: true}})))
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

interface PlannedAddition {
    trackId: string
    canonicalKey: string
    title: string
    artists: string[]
    durationMs?: number
}

// Give tracks that share a valid ISRC one key, without letting a one-sided ISRC replace a metadata match.
function alignRecordingKeys(source: ProviderTrack[], destination: ProviderTrack[]): [ProviderTrack[], ProviderTrack[]] {
    const [alignedSource, alignedDestination] = shareRecordingKeys([source, destination])
    return [alignedSource ?? source, alignedDestination ?? destination]
}

// Apply additions and removals needed to reach the reconciled playlist state.
// Matches are added in batches while searching, so a run stopped by a quota or an error keeps what it already added.
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
    unmatched: ProviderTrack[]
    // Tracks an append-only provider had to keep although the desired state drops them.
    retained: ProviderTrack[]
}> {
    const adapter = getAccountAdapter(account)
    const safeMode = isSafeModeEnabled()
    // An unavailable entry with no snapshot identity is not a song we can reconcile, so it is not removed.
    current = withoutUnknownUnavailable(current)
    const currentByKey = countTracks(current)
    const desiredByKey = new Map(desired.map((track) => [track.key, track]))
    const removedTracks: ProviderTrack[] = []
    const additions: PlannedAddition[] = []
    const unmatched: ProviderTrack[] = []
    const newMisses: string[] = []
    // YouTube inserts one video per request, so adding each match at once costs nothing and keeps progress when the quota runs out.
    const additionBatchSize = account.provider === "youtube" ? 1 : 50
    let pending: PlannedAddition[] = []

    for (const [key, occurrences] of currentByKey) {
        const desiredCount = desiredByKey.get(key)?.count || 0
        removedTracks.push(...occurrences.slice(desiredCount))
    }
    const flush = async () => {
        if (!pending.length || safeMode) return
        const batch = pending
        pending = []
        assertSyncLeaseHeld()
        const known = new Map(batch.map((item) => [item.trackId, item]))
        await adapter.addTracks(
            account,
            playlistId,
            batch.map((item) => item.trackId),
            async (addedTracks) => {
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
    const knownMisses = desired.some((track) => track.count > (currentByKey.get(track.key)?.length || 0)) ? await loadSearchMisses(account) : new Set<string>()
    try {
        for (const desiredTrack of desired) {
            const missing = desiredTrack.count - (currentByKey.get(desiredTrack.key)?.length || 0)
            // An unavailable entry has no metadata to search with.
            if (missing <= 0 || desiredTrack.reference.unavailable) continue
            for (let count = 0; count < missing; count++) {
                if (knownMisses.has(desiredTrack.key)) {
                    unmatched.push(desiredTrack.reference)
                    continue
                }
                assertSyncLeaseHeld()
                const match = await adapter.searchTrack(account, desiredTrack.reference)
                if (!match) {
                    unmatched.push(desiredTrack.reference)
                    newMisses.push(desiredTrack.key)
                    continue
                }
                const addition = {trackId: match.trackId, canonicalKey: desiredTrack.key, title: match.title, artists: match.artists, durationMs: match.durationMs}
                additions.push(addition)
                pending.push(addition)
                if (pending.length >= additionBatchSize) await flush()
            }
        }
        await flush()
    } finally {
        // Keep matches and misses found before a failure. The original error still ends the run.
        await Promise.allSettled([flush(), safeMode ? undefined : saveSearchMisses(account, newMisses)])
    }
    const skipped = unmatched.length
    // Apple Music cannot remove playlist tracks, so they stay and are not counted as removals.
    const retained = adapter.appendOnly ? removedTracks : []
    const removable = adapter.appendOnly ? [] : removedTracks
    const removals = removable.map((track) => track.itemId)
    if (additions.length || removals.length || skipped) {
        logger.info("Sync.applyDesired", account.provider, `Playlist ${playlistId}`, playlistName, `Additions ${additions.length}`, `Removals ${removals.length}`, `Unmatched ${skipped}`)
    }
    if (retained.length) {
        logger.info("Sync.applyDesired", account.provider, `Playlist ${playlistId}`, playlistName, `Kept ${retained.length} tracks the provider cannot remove`)
    }
    // PLS_SAFE_MODE logs the planned membership and leaves music providers untouched.
    if (safeMode) {
        logSafeModePlaylistUpdate({
            provider: account.provider,
            playlistId,
            playlistName,
            removals: removable,
            additions,
            unmatched,
            finalTracks: playlistAfterChanges(
                current,
                removals,
                additions.map((item) => ({itemId: item.trackId, trackId: item.trackId, title: item.title, artists: item.artists}))
            )
        })
        return {additions: additions.length, removals: removals.length, skipped, aliases: additions, unmatched, retained}
    }
    // Removals run after additions, so a failed addition never leaves a track deleted.
    if (removals.length) {
        assertSyncLeaseHeld()
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
    if (unmatched.length) {
        await recordChanges({
            unmatchedTracks: trackReferences(unmatchedOrigin.account, unmatchedOrigin.playlistId, unmatched, unmatchedOrigin.playlistName)
        })
    }
    return {additions: additions.length, removals: removals.length, skipped, aliases: additions, unmatched, retained}
}

// Keep destination tracks that a reverse restore could not copy, so the next mirror does not delete them.
function preserveRestoredTracks(desired: ReconciledTrack[], current: ProviderTrack[], preserved: Pick<SyncRunTrackReference, "providerTrackId" | "providerItemId">[]): ReconciledTrack[] {
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
async function restoredTracksToKeep(taskId: ObjectId, snapshot: SyncSnapshotDocument): Promise<Pick<SyncRunTrackReference, "providerTrackId" | "providerItemId">[]> {
    if (snapshot.preservedDestinationTracks) {
        return snapshot.preservedDestinationTracks
    }
    // Restores from before the snapshot kept this list are only recorded on their run.
    const db = await collections()
    const restore = await db.syncRuns
        .find({taskId, reverseSync: {$exists: true}, status: {$in: ["succeeded", "partial"]}})
        .sort({startedAt: -1})
        .limit(1)
        .next()
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
        return {missing: false, items: await getAccountAdapter(account).getPlaylistItems(account, playlistId)}
    } catch (error) {
        if (isMissingPlaylistError(error)) {
            return {missing: true}
        }
        throw error
    }
}

// Name the side whose playlist is gone and, for a deleted source, mark the run so restore can be offered.
function missingPlaylistError(account: ProviderAccountDocument, side: "source" | "destination", failureReason?: SyncFailureReason) {
    return createError({
        statusCode: 502,
        statusMessage: `The ${providerDisplayNames[account.provider]} ${side} playlist no longer exists`,
        ...(failureReason ? {data: {failureReason}} : {})
    })
}

// Fail with the side that is missing. Only a missing source, with the target still readable, can be restored from that target.
function playlistItemsOrThrow(sourceAccount: ProviderAccountDocument, sourceRead: PlaylistRead, destinationAccount: ProviderAccountDocument, destinationRead: PlaylistRead): [ProviderTrack[], ProviderTrack[]] {
    if (sourceRead.missing) {
        throw missingPlaylistError(sourceAccount, "source", destinationRead.missing ? undefined : "deleted-source")
    }
    if (destinationRead.missing) {
        throw missingPlaylistError(destinationAccount, "destination")
    }
    return [sourceRead.items, destinationRead.items]
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

// Refuse to write a playlist pair when an older task already writes one of its written playlists.
async function assertPlaylistsNotOwnedElsewhere(task: SyncTaskDocument, sourceAccount: ProviderAccountDocument, destinationAccount: ProviderAccountDocument) {
    if ((await playlistsWrittenByOtherTasks(task, destinationAccount._id!)).older.has(task.destination.playlistId)) {
        throw playlistOwnedElsewhereError(destinationAccount, "destination")
    }
    if (task.direction === "two-way" && (await playlistsWrittenByOtherTasks(task, sourceAccount._id!)).older.has(task.source.playlistId)) {
        throw playlistOwnedElsewhereError(sourceAccount, "source")
    }
}

interface SyncResult {
    additions: number
    removals: number
    skipped: number
    conflicts: number
}

type ApplyResult = Awaited<ReturnType<typeof applyDesired>>

const emptyApplyResult = (): ApplyResult => ({additions: 0, removals: 0, skipped: 0, aliases: [], unmatched: [], retained: []})

// Verified tracks an append-only side kept after the other side removed them.
// Storing them on both snapshot sides puts them in the next baseline, so they read as removed instead of as new tracks to copy back.
function keptAfterRemoval(verified: ProviderTrack[], retained: ProviderTrack[]): ProviderTrack[] {
    const itemIds = new Set(retained.map((track) => track.itemId))
    return verified.filter((track) => itemIds.has(track.itemId))
}

// Reconcile one playlist pair and refresh its matching snapshot.
async function executePlaylist(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress): Promise<SyncResult> {
    const db = await collections()
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const destinationAdapter = getAccountAdapter(destinationAccount)
    await assertPlaylistsNotOwnedElsewhere(task, sourceAccount, destinationAccount)
    const [sourceRead, destinationRead, snapshot] = await Promise.all([readPlaylistItems(sourceAccount, task.source.playlistId), readPlaylistItems(destinationAccount, task.destination.playlistId), db.syncSnapshots.findOne({taskId: task._id!})])
    const [sourceItems, destinationItems] = playlistItemsOrThrow(sourceAccount, sourceRead, destinationAccount, destinationRead)
    await reportProgress({tracksTotal: Math.max(sourceItems.length, destinationItems.length)})
    const oneWay = task.direction === "one-way"
    logger.info(
        "Sync.execute",
        `Task ${task._id!.toHexString()}`,
        `${sourceAccount.provider} items ${sourceItems.length}`,
        `${destinationAccount.provider} items ${destinationItems.length}`,
        snapshot ? (oneWay ? "Mirror run" : "Reconciliation run") : "Initial run"
    )

    let sourceResult = emptyApplyResult()
    let destinationResult = emptyApplyResult()
    let conflicts: string[] = []
    let pairedDestination: ProviderTrack[] = []
    // The source list whose keys were reconciled, so the snapshot stores the same identity on both sides.
    let identitySource: ProviderTrack[] = sourceItems
    const toDestination = {account: sourceAccount, playlistId: task.source.playlistId, playlistName: task.source.name}
    const toSource = {account: destinationAccount, playlistId: task.destination.playlistId, playlistName: task.destination.name}
    if (!snapshot) {
        if (!oneWay) {
            // First two-way runs baseline both sides so destination-only tracks survive, and copies already on both sides are paired instead of added again.
            const [source, destination] = alignRecordingKeys(withoutUnknownUnavailable(sourceItems), withoutUnknownUnavailable(destinationItems))
            identitySource = source
            pairedDestination = pairMatchingTracks(source, destination)
            const reconciliation = reconcileThreeWay(commonTracks(source, pairedDestination), source, pairedDestination)
            conflicts = reconciliation.conflicts
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, pairedDestination, reconciliation.desired, recordChanges, task.destination.name, toDestination)
            sourceResult = await applyDesired(sourceAccount, task.source.playlistId, source, reconciliation.desired, recordChanges, task.source.name, toSource)
        } else if (destinationAdapter.appendOnly) {
            // The target cannot be cleared, so its tracks are paired with the source and only the missing ones are added.
            const [source, destination] = alignRecordingKeys(withoutUnknownUnavailable(sourceItems), withoutUnknownUnavailable(destinationItems))
            identitySource = source
            pairedDestination = pairMatchingTracks(source, destination)
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, pairedDestination, reconcileOneWay(source).desired, recordChanges, task.destination.name, toDestination)
        } else {
            identitySource = withoutUnknownUnavailable(sourceItems)
            const desired = reconcileOneWay(identitySource).desired
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
            // Remember that the target was cleared, so a run that stops partway does not clear the tracks it already added.
            if (!isSafeModeEnabled()) {
                await db.syncSnapshots.updateOne({taskId: task._id!}, {$set: {sourceItems: [], destinationItems: [], createdAt: new Date()}}, {upsert: true})
            }
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, [], desired, recordChanges, task.destination.name, toDestination)
            destinationResult.removals = destinationItems.length
        }
    } else {
        const knownKeys = matchedSnapshotKeys(snapshot.sourceItems, snapshot.destinationItems)
        const [aliasedSource, aliasedDestination] = alignRecordingKeys(
            withoutUnknownUnavailable(applyAliases(sourceItems, aliasMap(snapshot.sourceItems))),
            withoutUnknownUnavailable(applyAliases(destinationItems, aliasMap(snapshot.destinationItems)))
        )
        identitySource = aliasedSource
        pairedDestination = pairMatchingTracks(aliasedSource, aliasedDestination, knownKeys)
        if (oneWay) {
            const desired = preserveRestoredTracks(reconcileOneWay(aliasedSource).desired, pairedDestination, await restoredTracksToKeep(task._id!, snapshot))
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, pairedDestination, desired, recordChanges, task.destination.name, toDestination)
        } else {
            const baseline = commonTracks(snapshot.sourceItems.map(fromCanonical), snapshot.destinationItems.map(fromCanonical))
            const reconciliation = reconcileThreeWay(baseline, aliasedSource, pairedDestination)
            conflicts = reconciliation.conflicts
            if (conflicts.length) {
                logger.warn("Sync.reconcile", `Task ${task._id!.toHexString()}`, `Conflicts ${conflicts.length}`)
            }
            sourceResult = await applyDesired(sourceAccount, task.source.playlistId, aliasedSource, reconciliation.desired, recordChanges, task.source.name, toSource)
            destinationResult = await applyDesired(destinationAccount, task.destination.playlistId, pairedDestination, reconciliation.desired, recordChanges, task.destination.name, toDestination)
        }
    }

    if (isSafeModeEnabled()) {
        logger.info("Sync.safeMode", `Task ${task._id!.toHexString()}`, "Skipping snapshot update")
    } else {
        const [verifiedSourceRead, verifiedDestinationRead] = await Promise.all([readPlaylistItems(sourceAccount, task.source.playlistId), readPlaylistItems(destinationAccount, task.destination.playlistId)])
        const [verifiedSource, verifiedDestination] = playlistItemsOrThrow(sourceAccount, verifiedSourceRead, destinationAccount, verifiedDestinationRead)
        const desiredAliases = new Map<string, string>([
            ...(snapshot ? [...aliasMap(snapshot.sourceItems), ...aliasMap(snapshot.destinationItems)] : []),
            ...pairedAliases(pairedDestination),
            ...sourceResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const),
            ...destinationResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const)
        ])
        const identityAliases = new Map(identitySource.flatMap((track) => [[track.itemId, trackKey(track)] as const, [track.trackId, trackKey(track)] as const]))
        const normalizedAliases = new Map([...countTracks(sourceItems)].map(([key, occurrences]) => [trackKey(occurrences[0]!), key] as const))
        const canonicalize = (items: ProviderTrack[]) =>
            withoutUnknownUnavailable(
                items.map((item) => ({
                    ...item,
                    canonicalKey: identityAliases.get(item.itemId) || identityAliases.get(item.trackId) || desiredAliases.get(item.itemId) || desiredAliases.get(item.trackId) || (item.unavailable ? undefined : normalizedAliases.get(trackKey(item)))
                }))
            )
        const canonicalSource = canonicalize(verifiedSource)
        const canonicalDestination = canonicalize(verifiedDestination)
        const keptOnSource = oneWay ? [] : keptAfterRemoval(canonicalSource, sourceResult.retained)
        const keptOnDestination = oneWay ? [] : keptAfterRemoval(canonicalDestination, destinationResult.retained)
        await db.syncSnapshots.updateOne(
            {taskId: task._id!},
            {
                $set: {
                    sourceItems: [...canonicalSource, ...keptOnDestination].map(toCanonical),
                    destinationItems: [...canonicalDestination, ...keptOnSource].map(toCanonical),
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

// Mirror one source playlist into its mapped destination playlist, keeping the pairs its last snapshot recorded.
async function mirrorPlaylist(
    sourceAccount: ProviderAccountDocument,
    destinationAccount: ProviderAccountDocument,
    sourcePlaylistId: string,
    destinationPlaylistId: string,
    playlistName: string,
    recordChanges: RecordTrackChanges,
    manualAliases: PlaylistMapping["manualAliases"] = [],
    snapshot?: AccountSnapshotPlaylist
) {
    const sourceAdapter = getAccountAdapter(sourceAccount)
    const destinationAdapter = getAccountAdapter(destinationAccount)
    const [sourceItems, destinationItems] = await Promise.all([sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylistId), destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylistId)])
    const manual: [string, string][] = (manualAliases || []).flatMap((alias) => [
        [alias.sourceTrackId, alias.canonicalKey],
        ...(alias.sourceItemId ? [[alias.sourceItemId, alias.canonicalKey] as [string, string]] : []),
        [alias.destinationTrackId, alias.canonicalKey],
        ...(alias.destinationItemId ? [[alias.destinationItemId, alias.canonicalKey] as [string, string]] : [])
    ])
    // A snapshot from another destination playlist describes other items, so only its source aliases still apply.
    const sameDestination = snapshot?.destinationPlaylistId === destinationPlaylistId
    const sourceAliases = new Map([...aliasMap(snapshot?.sourceItems || []), ...manual])
    const destinationAliases = new Map([...aliasMap(sameDestination ? snapshot.destinationItems : []), ...manual])
    const knownKeys = sameDestination ? matchedSnapshotKeys(snapshot.sourceItems, snapshot.destinationItems) : new Set<string>()
    const [aliasedSource, destinationWithAliases] = alignRecordingKeys(withoutUnknownUnavailable(applyAliases(sourceItems, sourceAliases)), withoutUnknownUnavailable(applyAliases(destinationItems, destinationAliases)))
    const aliasedDestination = pairMatchingTracks(aliasedSource, destinationWithAliases, knownKeys)
    const result = await applyDesired(destinationAccount, destinationPlaylistId, aliasedDestination, reconcileOneWay(aliasedSource).desired, recordChanges, playlistName, {account: sourceAccount, playlistId: sourcePlaylistId, playlistName})
    const verifiedSourceAliases = new Map(sourceAliases)
    const verifiedDestinationAliases = new Map([...destinationAliases, ...pairedAliases(aliasedDestination)])
    for (const alias of result.aliases) verifiedDestinationAliases.set(alias.trackId, alias.canonicalKey)
    const withKey = (items: ProviderTrack[], aliases: Map<string, string>) =>
        withoutUnknownUnavailable(items.map((item) => ({...item, canonicalKey: aliases.get(item.itemId) || aliases.get(item.trackId) || (item.unavailable ? undefined : item.canonicalKey || trackKey(item))})))
    const [verifiedSource, verifiedDestination] = isSafeModeEnabled()
        ? [aliasedSource, aliasedDestination]
        : await Promise.all([sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylistId), destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylistId)])
    return {
        ...result,
        snapshotPlaylist: {
            sourcePlaylistId,
            destinationPlaylistId,
            name: playlistName,
            sourceItems: withKey(verifiedSource, verifiedSourceAliases).map(toCanonical),
            destinationItems: withKey(verifiedDestination, verifiedDestinationAliases).map(toCanonical)
        }
    }
}

interface OtherTaskWrites {
    // Every playlist another task writes to, so name matching never claims one.
    any: Set<string>
    // Playlists an older task writes to. The oldest writer keeps the playlist, which also settles tasks created at the same moment.
    older: Set<string>
}

// Playlists on one provider account that the user's other tasks write to.
async function playlistsWrittenByOtherTasks(task: SyncTaskDocument, providerAccountId: ObjectId): Promise<OtherTaskWrites> {
    const db = await collections()
    const others = await db.syncTasks.find({userId: task.userId}).toArray()
    const writes: OtherTaskWrites = {any: new Set(), older: new Set()}
    for (const other of others) {
        if (other._id?.equals(task._id!)) continue
        const sides = writtenPlaylistRefs(other)
            .filter((ref) => ref.providerAccountId.equals(providerAccountId))
            .map((ref) => ref.playlistId)
        const [otherCreated, taskCreated] = [other.createdAt?.getTime() ?? 0, task.createdAt?.getTime() ?? 0]
        const older = otherCreated < taskCreated || (otherCreated === taskCreated && other._id!.toHexString() < task._id!.toHexString())
        for (const playlistId of sides) {
            writes.any.add(playlistId)
            if (older) writes.older.add(playlistId)
        }
    }
    return writes
}

function playlistOwnedElsewhereError(account: ProviderAccountDocument, side: "source" | "destination") {
    return createError({statusCode: 409, statusMessage: `An older sync task already writes to the ${providerDisplayNames[account.provider]} ${side} playlist`})
}

// Errors that stop the whole full sync instead of only the playlist being synced.
function stopsAccountSync(error: unknown): boolean {
    return isSyncLeaseLostError(error) || isQuotaExceededError(error)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : "Unknown synchronization error"
}

// Synchronize every source playlist and maintain destination mappings. One failing playlist does not stop the others.
async function executeAccount(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress): Promise<SyncResult> {
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const sourceAdapter = getAccountAdapter(sourceAccount)
    const destinationAdapter = getAccountAdapter(destinationAccount)
    const [sourcePlaylists, destinationPlaylists, snapshots, writtenElsewhere] = await Promise.all([
        sourceAdapter.listPlaylists(sourceAccount),
        destinationAdapter.listPlaylists(destinationAccount, {writableOnly: true}),
        loadTaskSnapshots(task._id!),
        playlistsWrittenByOtherTasks(task, destinationAccount._id!)
    ])
    const snapshotPlaylistsById = new Map(snapshots.flatMap((snapshot) => snapshot.playlists || []).map((playlist) => [playlist.sourcePlaylistId, playlist]))
    const destinationById = new Map(destinationPlaylists.map((playlist) => [playlist.id, playlist]))
    const mappings: PlaylistMapping[] = [...(task.playlistMappings || [])]
    // Name matching skips playlists another task already writes to, so two tasks never undo each other.
    const claimedDestinationIds = new Set([...mappings.map((mapping) => mapping.destinationPlaylistId), ...writtenElsewhere.any])
    const sourceIds = new Set(sourcePlaylists.map((playlist) => playlist.id))
    const missingSourcePlaylists: SyncRunPlaylistIssue[] = mappings
        .filter((mapping) => !sourceIds.has(mapping.sourcePlaylistId))
        .map((mapping) => ({sourcePlaylistId: mapping.sourcePlaylistId, destinationPlaylistId: mapping.destinationPlaylistId, name: mapping.name}))
    if (missingSourcePlaylists.length) {
        await recordChanges({missingSourcePlaylists})
    }
    // Issues are saved on the run as they happen, so they stay visible even when the run fails.
    const failedPlaylists: SyncRunPlaylistIssue[] = []
    let firstFailure: unknown
    // Re-read aliases at save time so a manual match is not replaced by this older copy.
    const persistMappings = () => saveMergedPlaylistMappings(task._id!, mappings)
    let additions = 0
    let removals = 0
    let skipped = 0
    let playlistsCompleted = 0
    const snapshotPlaylists: AccountSnapshotPlaylist[] = []
    await reportProgress({playlistsTotal: sourcePlaylists.length, playlistsCompleted: 0})

    const syncPlaylist = async (sourcePlaylist: ProviderPlaylist) => {
        let mapping = mappings.find((item) => item.sourcePlaylistId === sourcePlaylist.id)
        let destinationPlaylist: ProviderPlaylist | undefined = mapping ? destinationById.get(mapping.destinationPlaylistId) : undefined
        if (!destinationPlaylist) {
            destinationPlaylist = destinationPlaylists.find((playlist) => playlist.name === sourcePlaylist.name && !claimedDestinationIds.has(playlist.id))
        }
        if (!destinationPlaylist) {
            if (isSafeModeEnabled()) {
                logSafeModeCreatePlaylist(destinationAccount.provider, sourcePlaylist.name)
                const sourceItems = await sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylist.id)
                return applyDesired(destinationAccount, `(new) ${sourcePlaylist.name}`, [], reconcileOneWay(withoutUnknownUnavailable(sourceItems)).desired, recordChanges, sourcePlaylist.name, {
                    account: sourceAccount,
                    playlistId: sourcePlaylist.id,
                    playlistName: sourcePlaylist.name
                })
            }
            destinationPlaylist = await destinationAdapter.createPlaylist(destinationAccount, sourcePlaylist.name, sourcePlaylist.description)
            destinationPlaylists.push(destinationPlaylist)
            destinationById.set(destinationPlaylist.id, destinationPlaylist)
        }
        // An existing mapping can point at a playlist an older task also writes. That task keeps it.
        if (writtenElsewhere.older.has(destinationPlaylist.id)) {
            throw playlistOwnedElsewhereError(destinationAccount, "destination")
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
        const result = await mirrorPlaylist(sourceAccount, destinationAccount, sourcePlaylist.id, destinationPlaylist.id, mapping.name, recordChanges, mapping.manualAliases, snapshotPlaylistsById.get(sourcePlaylist.id))
        snapshotPlaylists.push(result.snapshotPlaylist)
        return result
    }

    for (const sourcePlaylist of sourcePlaylists) {
        assertSyncLeaseHeld()
        try {
            const result = await syncPlaylist(sourcePlaylist)
            additions += result.additions
            removals += result.removals
            skipped += result.skipped
        } catch (error) {
            if (stopsAccountSync(error)) throw error
            firstFailure ??= error
            logger.warn("Sync.executeAccount", `Task ${task._id!.toHexString()}`, `Playlist ${sourcePlaylist.id}`, sourcePlaylist.name, "Skipped after an error", error)
            const issue = {sourcePlaylistId: sourcePlaylist.id, name: sourcePlaylist.name, error: errorMessage(error)}
            failedPlaylists.push(issue)
            await recordChanges({failedPlaylists: [issue]})
            // Keep the last snapshot of this pair so its aliases survive until it syncs again.
            const previous = snapshotPlaylistsById.get(sourcePlaylist.id)
            if (previous) snapshotPlaylists.push(previous)
        }
        playlistsCompleted += 1
        await reportProgress({playlistsTotal: sourcePlaylists.length, playlistsCompleted})
    }
    // When every playlist failed, the cause is usually the account itself, so the run fails and backs off.
    if (failedPlaylists.length && failedPlaylists.length === sourcePlaylists.length) {
        throw firstFailure
    }

    if (!isSafeModeEnabled()) {
        await saveAccountSnapshotBatches(task._id!, snapshotPlaylists)
    }
    logger.info(
        "Sync.executeAccount",
        `Task ${task._id!.toHexString()}`,
        `Playlists ${sourcePlaylists.length}`,
        `Failed ${failedPlaylists.length}`,
        `Missing sources ${missingSourcePlaylists.length}`,
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
        await getAccountAdapter(account).deletePlaylist(account, playlistId)
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
                throw missingPlaylistError(toAccount, reverse ? "source" : "destination")
            }
            if (isSafeModeEnabled()) {
                logSafeModeCreatePlaylist(toAccount.provider, toRef.name)
                throw createError({statusCode: 503, statusMessage: safeModeWriteBlockedMessage})
            }
            const created = await getAccountAdapter(toAccount).createPlaylist(toAccount, toRef.name)
            createdPlaylistId = created.id
            toPlaylistId = created.id
            logger.info("Sync.reverse", `Task ${task._id!.toHexString()}`, syncCase.reason, toAccount.provider, `Created playlist ${created.id}`)
        } else if (syncCase.recreateTarget) {
            throw createError({statusCode: 409, statusMessage: "The playlist to restore is already there"})
        } else {
            toItems = toRead.items
        }
        const [sharedFrom, sharedTo] = alignRecordingKeys(withoutUnknownUnavailable(fromRead.items), withoutUnknownUnavailable(toItems))
        const result = await applyDesired(toAccount, toPlaylistId, sharedTo, reconcileOneWay(sharedFrom).desired, recordChanges, toRef.name, {
            account: fromAccount,
            playlistId: fromRef.playlistId,
            playlistName: fromRef.name
        })
        if (!isSafeModeEnabled()) {
            const [verifiedFromRead, verifiedToRead] = await Promise.all([readPlaylistItems(fromAccount, fromRef.playlistId), readPlaylistItems(toAccount, toPlaylistId)])
            if (verifiedFromRead.missing || verifiedToRead.missing) {
                const missingFrom = verifiedFromRead.missing
                throw missingPlaylistError(missingFrom ? fromAccount : toAccount, missingFrom === reverse ? "destination" : "source")
            }
            const verifiedFrom = verifiedFromRead.items
            const verifiedTo = verifiedToRead.items
            const aliases = new Map(result.aliases.map((item) => [item.trackId, item.canonicalKey]))
            const withAliases = (items: ProviderTrack[]) => items.map((item) => ({...item, canonicalKey: aliases.get(item.itemId) || aliases.get(item.trackId) || item.canonicalKey}))
            const sourceItems = reverse ? withAliases(verifiedTo) : verifiedFrom
            const destinationItems = reverse ? verifiedFrom : withAliases(verifiedTo)
            // A reverse copy keeps target tracks it could not copy back, and later mirrors must keep them too.
            const preserved = reverse ? {preservedDestinationTracks: result.unmatched.map((track) => ({providerTrackId: track.trackId, providerItemId: track.itemId}))} : {}
            await db.syncSnapshots.updateOne({taskId: task._id!}, {$set: {sourceItems: sourceItems.map(toCanonical), destinationItems: destinationItems.map(toCanonical), ...preserved, createdAt: new Date()}}, {upsert: true})
            if (createdPlaylistId) {
                if (reverse) {
                    task.source = {...task.source, playlistId: createdPlaylistId}
                } else {
                    task.destination = {...task.destination, playlistId: createdPlaylistId}
                }
                const playlistWriteKeys = storedPlaylistWriteKeys(task)
                await db.syncTasks.updateOne({_id: task._id}, {$set: {source: task.source, destination: task.destination, ...(playlistWriteKeys ? {playlistWriteKeys} : {}), updatedAt: new Date()}})
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
async function execute(task: SyncTaskDocument, recordChanges: RecordTrackChanges, reportProgress: ReportProgress, reverseSync?: ReverseSyncRequest): Promise<SyncResult> {
    if (reverseSync) {
        return executeReverseSync(task, recordChanges, reverseSync)
    }
    return task.mode === "account" ? executeAccount(task, recordChanges, reportProgress) : executePlaylist(task, recordChanges, reportProgress)
}

const interruptedRunMessage = "The sync stopped before it finished"

// Mark runs left running by a crash or a deploy as failed, once their task no longer holds a live lease.
export async function failInterruptedRuns(now = new Date()) {
    const db = await collections()
    const startedBefore = new Date(now.getTime() - syncLeaseDurationMs)
    const stale = await db.syncRuns.find({status: "running", startedAt: {$lt: startedBefore}}, {projection: {taskId: 1}}).toArray()
    let failed = 0
    for (const taskId of new Map(stale.map((run) => [run.taskId.toHexString(), run.taskId])).values()) {
        const task = await db.syncTasks.findOne({_id: taskId}, {projection: {leaseExpiresAt: 1}})
        if (leaseIsActive(task?.leaseExpiresAt, now.getTime())) continue
        const result = await db.syncRuns.updateMany({taskId, status: "running", startedAt: {$lt: startedBefore}}, {$set: {status: "failed", error: interruptedRunMessage, finishedAt: now}, $unset: {progress: ""}})
        failed += result.modifiedCount
    }
    if (failed) {
        logger.warn("Sync.interrupted", `Runs ${failed}`, "Marked as failed")
    }
    return failed
}

// Interval between scheduled runs on the task owner's plan.
async function scheduledIntervalMs(userId: ObjectId): Promise<number> {
    const db = await collections()
    const user = await db.users.findOne({_id: userId})
    return user && resolveEntitlement(user).tier === "pro" ? proSyncIntervalMs(getServerConfig().proSyncIntervalMinutes) : 7 * 24 * 60 * 60 * 1000
}

/**
 * Next run of a successful sync, kept on the cadence of its due time so scheduler ticks and run time do not push it later every cycle.
 * A run that started late still waits at least half an interval, so a backlog does not run tasks back to back.
 * @param dueAt When a scheduled run was due, or undefined for runs started by a user.
 */
export function nextScheduledRunAt(dueAt: Date | undefined, finishedAt: Date, intervalMs: number): Date {
    if (!dueAt || dueAt > finishedAt) {
        return new Date(finishedAt.getTime() + intervalMs)
    }
    return new Date(Math.max(dueAt.getTime() + intervalMs, finishedAt.getTime() + intervalMs / 2))
}

const failureBackoffBaseMs = 60 * 60 * 1000

// Retry a failing task after 1 hour, doubling with each consecutive failure, but never later than its usual schedule.
export function failureBackoffMs(consecutiveFailures: number, intervalMs: number): number {
    return Math.min(intervalMs, failureBackoffBaseMs * 2 ** Math.max(0, consecutiveFailures - 1))
}

// Short task-card summary of the full-sync playlists that could not be synced.
function failedPlaylistsMessage(failed: SyncRunPlaylistIssue[]): string {
    const names = failed.map((playlist) => `"${playlist.name}"`).join(", ")
    return `${failed.length === 1 ? "1 playlist" : `${failed.length} playlists`} could not be synced: ${names}`.slice(0, 500)
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
    // This run holds the lease now, so any run still marked running was cut off by a crash or a deploy.
    await db.syncRuns.updateMany({taskId, status: "running"}, {$set: {status: "failed", error: interruptedRunMessage, finishedAt: now}, $unset: {progress: ""}})
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
    const {task, taskId, leaseId, runId, trigger, startedAt, taskLabel, reverseSync} = context
    const recordChanges: RecordTrackChanges = async ({addedTracks = [], removedTracks = [], unmatchedTracks = [], failedPlaylists = [], missingSourcePlaylists = []}) => {
        if (failedPlaylists.length) {
            await db.syncRuns.updateOne({_id: runId}, {$push: {failedPlaylists: {$each: failedPlaylists}}})
        }
        if (missingSourcePlaylists.length) {
            await db.syncRuns.updateOne({_id: runId}, {$push: {missingSourcePlaylists: {$each: missingSourcePlaylists}}})
        }
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
        const executed: SyncResult = await syncLeaseHold.run(leaseHold, async () => execute(task, recordChanges, reportProgress, reverseSync))
        // Additions and removals were counted as each write landed, including writes of a playlist that later failed.
        // Safe mode writes nothing, so its planned counts are kept.
        const recorded = await db.syncRuns.findOne({_id: runId})
        const result: SyncResult = isSafeModeEnabled() ? executed : {...executed, additions: recorded?.additions ?? 0, removals: recorded?.removals ?? 0}
        const failedPlaylists = recorded?.failedPlaylists || []
        const missingSourcePlaylists = recorded?.missingSourcePlaylists || []
        const nextRunMs = await scheduledIntervalMs(task.userId)
        const finishedAt = new Date()
        const warning = failedPlaylists.length ? failedPlaylistsMessage(failedPlaylists) : undefined
        const completed = await db.syncTasks.updateOne(
            {_id: taskId, leaseId, pauseReason: {$ne: "entitlement"}},
            {
                $set: {
                    status: result.conflicts ? "needs_attention" : "active",
                    lastRunAt: finishedAt,
                    lastSuccessAt: finishedAt,
                    nextRunAt: nextScheduledRunAt(trigger === "scheduled" ? task.nextRunAt : undefined, finishedAt, nextRunMs),
                    updatedAt: finishedAt,
                    ...(warning ? {lastError: warning} : {})
                },
                $unset: {leaseId: "", leaseExpiresAt: "", consecutiveFailures: "", ...(warning ? {} : {lastError: ""})}
            }
        )
        const partial = result.skipped || result.conflicts || failedPlaylists.length || missingSourcePlaylists.length
        await db.syncRuns.updateOne({_id: runId}, {$set: {...result, status: partial ? "partial" : "succeeded", finishedAt}, $unset: {progress: ""}})
        if (!completed.matchedCount) {
            // Release only the lease this run still holds. A newer run's lease stays in place.
            const released = await db.syncTasks.updateOne(
                {_id: taskId, leaseId},
                {
                    $set: {lastRunAt: finishedAt, lastSuccessAt: finishedAt, updatedAt: finishedAt},
                    $unset: {leaseId: "", leaseExpiresAt: "", lastError: "", consecutiveFailures: ""}
                }
            )
            if (!released.matchedCount) {
                logger.warn("Sync.lease", `Task ${taskId.toHexString()}`, "Lease was no longer held; task lock was left unchanged")
            }
        }
        const log = partial ? logger.warn : logger.info
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
        const message = errorMessage(error)
        const failureReason = readSyncFailureReason(error)
        // A used-up quota waits for its reset. Other failures back off so failing tasks do not hold the head of the scheduler queue.
        const quotaExceeded = isQuotaExceededError(error)
        const consecutiveFailures = (task.consecutiveFailures || 0) + (quotaExceeded ? 0 : 1)
        const nextRunAt = quotaExceeded ? nextQuotaResetAt(finishedAt) : new Date(finishedAt.getTime() + failureBackoffMs(consecutiveFailures, await scheduledIntervalMs(task.userId).catch(() => failureBackoffBaseMs)))
        const failed = await db.syncTasks.updateOne(
            {_id: taskId, leaseId},
            {
                $set: {lastRunAt: finishedAt, lastError: message, nextRunAt, consecutiveFailures, updatedAt: finishedAt},
                $unset: {leaseId: "", leaseExpiresAt: ""}
            }
        )
        await db.syncRuns.updateOne({_id: runId}, {$set: {status: "failed", error: message, finishedAt, ...(failureReason ? {failureReason} : {})}, $unset: {progress: ""}})
        if (!failed.matchedCount) {
            logger.warn("Sync.lease", `Task ${taskId.toHexString()}`, "Lease was no longer held; task lock was left unchanged")
        }
        logger.error("Sync.run", `Task ${taskId.toHexString()}`, taskLabel, `Run ${runId.toHexString()}`, `Duration ${finishedAt.getTime() - startedAt.getTime()}ms`, `Next run ${nextRunAt.toISOString()}`, error)
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
