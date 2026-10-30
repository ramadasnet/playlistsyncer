// Suggest similar catalog tracks and persist a manual match so later syncs keep the pair.
import {ObjectId} from "mongodb"
import type {CanonicalTrack, ManualTrackAlias, Provider, ProviderAccountDocument, SyncRunDocument, SyncRunTrackReference, SyncSnapshotDocument, SyncTaskDocument} from "~~/shared/types/domain"
import {catalogSearchLabel, parseCatalogSearchLabel} from "~~/shared/catalog-search"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {getAccountAdapter, type ProviderTrack} from "../providers"
import {rankSimilarTracks} from "../providers/matching"
import {providerTrackUrl} from "../providers/track-ids"
import {unmatchedTracksFromSnapshot} from "./history-visibility"
import {combinedSnapshot, loadTaskSnapshots, snapshotItemsForPlaylist} from "./snapshot-batches"
import {saveMergedPlaylistMappings} from "./playlist-mappings"
import {isSafeModeEnabled, safeModeWriteBlockedMessage} from "./safe-mode"
import {assertSyncTaskIdle, withTaskLease} from "./task-activity"
import {trackKey} from "./reconcile"

export interface UnmatchedTrackIdentity {
    playlistId: string
    providerTrackId: string
    providerItemId?: string
    runId?: string
    query?: string
}

export interface MatchTarget {
    unmatchedSide: "source" | "destination"
    targetSide: "source" | "destination"
    targetPlaylistId: string
    targetPlaylistName: string
}

export interface SimilarTrackSuggestion {
    trackId: string
    title: string
    artists: string[]
    album?: string
    durationMs?: number
    imageUrl?: string
    url?: string
}

export interface MatchSuggestionsResult {
    unmatched: {title: string; artists: string[]; playlistName?: string; durationMs?: number}
    targetProvider: ProviderAccountDocument["provider"]
    targetPlaylistName: string
    query: string
    suggestions: SimilarTrackSuggestion[]
}

export interface ManualMatchResult {
    added: boolean
    linked: boolean
    title: string
    artists: string[]
}

// Decide which playlist should receive a manually chosen stand-in for an unmatched track.
export function resolveMatchTarget(task: Pick<SyncTaskDocument, "source" | "destination" | "playlistMappings">, unmatchedPlaylistId: string): MatchTarget {
    if (unmatchedPlaylistId === task.source.playlistId) {
        return {unmatchedSide: "source", targetSide: "destination", targetPlaylistId: task.destination.playlistId, targetPlaylistName: task.destination.name}
    }
    if (unmatchedPlaylistId === task.destination.playlistId) {
        return {unmatchedSide: "destination", targetSide: "source", targetPlaylistId: task.source.playlistId, targetPlaylistName: task.source.name}
    }
    const mapping = (task.playlistMappings || []).find((item) => item.sourcePlaylistId === unmatchedPlaylistId || item.destinationPlaylistId === unmatchedPlaylistId)
    if (mapping?.sourcePlaylistId === unmatchedPlaylistId) {
        return {unmatchedSide: "source", targetSide: "destination", targetPlaylistId: mapping.destinationPlaylistId, targetPlaylistName: mapping.name}
    }
    if (mapping?.destinationPlaylistId === unmatchedPlaylistId) {
        return {unmatchedSide: "destination", targetSide: "source", targetPlaylistId: mapping.sourcePlaylistId, targetPlaylistName: mapping.name}
    }
    throw createError({statusCode: 400, statusMessage: "Unmatched track does not belong to this sync task"})
}

// True when a stored unmatched row is the track the user asked to match.
export function unmatchedTrackMatches(track: Pick<SyncRunTrackReference, "playlistId" | "providerTrackId" | "providerItemId">, identity: UnmatchedTrackIdentity) {
    if (track.playlistId !== identity.playlistId || track.providerTrackId !== identity.providerTrackId) {
        return false
    }
    if (identity.providerItemId && track.providerItemId && track.providerItemId !== identity.providerItemId) {
        return false
    }
    return true
}

// Locate a snapshot row by playlist item id, then by stable provider track id.
export function findSnapshotItem(items: CanonicalTrack[], identity: Pick<UnmatchedTrackIdentity, "providerItemId" | "providerTrackId">) {
    if (identity.providerItemId) {
        const byItem = items.find((item) => item.providerItemId === identity.providerItemId)
        if (byItem) return byItem
    }
    return items.find((item) => item.providerTrackId === identity.providerTrackId)
}

function aliasEntries(items: CanonicalTrack[]): [string, string][] {
    return items.flatMap((item) => [
        [item.providerItemId, item.canonicalKey],
        [item.providerTrackId, item.canonicalKey]
    ])
}

// Build alias keys so the unmatched source row and the chosen catalog track share an identity.
export function manualMatchAliases(
    snapshot: Pick<SyncSnapshotDocument, "sourceItems" | "destinationItems"> | null,
    unmatched: Pick<UnmatchedTrackIdentity, "providerItemId" | "providerTrackId">,
    added: {providerItemId?: string; providerTrackId: string},
    sharedKey: string
) {
    const aliases = new Map<string, string>(snapshot ? [...aliasEntries(snapshot.sourceItems), ...aliasEntries(snapshot.destinationItems)] : [])
    aliases.set(unmatched.providerTrackId, sharedKey)
    if (unmatched.providerItemId) {
        aliases.set(unmatched.providerItemId, sharedKey)
    }
    aliases.set(added.providerTrackId, sharedKey)
    if (added.providerItemId) {
        aliases.set(added.providerItemId, sharedKey)
    }
    return aliases
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

// Apply snapshot aliases, then fall back to metadata keys for unaliased tracks.
export function canonicalItemsWithAliases(items: ProviderTrack[], aliases: Map<string, string>): CanonicalTrack[] {
    return items.map((item) =>
        toCanonical({
            ...item,
            canonicalKey: aliases.get(item.itemId) || aliases.get(item.trackId) || trackKey(item)
        })
    )
}

function serializeSuggestion(provider: Provider, track: ProviderTrack): SimilarTrackSuggestion {
    const url = providerTrackUrl(provider, track)
    return {
        trackId: track.trackId,
        title: track.title,
        artists: track.artists,
        ...(track.album ? {album: track.album} : {}),
        ...(track.durationMs ? {durationMs: track.durationMs} : {}),
        ...(track.imageUrl ? {imageUrl: track.imageUrl} : {}),
        ...(url ? {url} : {})
    }
}

function asSearchTrack(track: SyncRunTrackReference, snapshotItem?: CanonicalTrack): ProviderTrack {
    return {
        itemId: track.providerItemId || track.providerTrackId,
        trackId: track.providerTrackId,
        title: snapshotItem?.title || track.title || "",
        artists: snapshotItem?.artists || track.artists,
        album: snapshotItem?.album,
        durationMs: snapshotItem?.durationMs || track.durationMs,
        isrc: snapshotItem?.isrc
    }
}

async function loadOwnedTask(taskId: ObjectId, userId: ObjectId) {
    const db = await collections()
    const task = await db.syncTasks.findOne({_id: taskId, userId})
    if (!task) {
        throw createError({statusCode: 404, statusMessage: "Sync task not found"})
    }
    return {db, task}
}

async function loadAccount(id: ObjectId, userId: ObjectId): Promise<ProviderAccountDocument> {
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: id, userId})
    if (!account) {
        throw createError({statusCode: 409, statusMessage: "A connected provider account is missing"})
    }
    return account
}

function playlistPairTarget(task: Pick<SyncTaskDocument, "source" | "destination">, unmatchedSide: "source" | "destination"): MatchTarget {
    return unmatchedSide === "source"
        ? {unmatchedSide: "source", targetSide: "destination", targetPlaylistId: task.destination.playlistId, targetPlaylistName: task.destination.name}
        : {unmatchedSide: "destination", targetSide: "source", targetPlaylistId: task.source.playlistId, targetPlaylistName: task.source.name}
}

function liveTrackMatches(track: ProviderTrack, identity: UnmatchedTrackIdentity) {
    return (identity.providerItemId && track.itemId === identity.providerItemId) || track.trackId === identity.providerTrackId
}

const suggestionLimit = 5

// Pull catalog candidates, retrying without ISRC so near-matches can still surface.
async function searchSuggestionCandidates(account: ProviderAccountDocument, source: ProviderTrack) {
    const adapter = getAccountAdapter(account)
    const primary = await adapter.searchTrackCandidates(account, source)
    if (!source.isrc) {
        return primary
    }
    const byTitle = await adapter.searchTrackCandidates(account, {...source, isrc: undefined})
    return [...primary, ...byTitle]
}

// Keep the first unique tracks, in the order the provider returned them.
function firstUniqueTracks(candidates: ProviderTrack[], limit: number) {
    const seen = new Set<string>()
    const tracks: ProviderTrack[] = []
    for (const track of candidates) {
        if (seen.has(track.trackId)) continue
        seen.add(track.trackId)
        tracks.push(track)
        if (tracks.length === limit) break
    }
    return tracks
}

// The search box value: the user's text, or "Title - Artist" from the catalog search.
function suggestionQuery(provider: Provider, source: ProviderTrack, query?: string) {
    const text = query?.trim()
    return text || catalogSearchLabel(provider, source)
}

// Rank the usual near-matches, or take the top catalog hits for a replacement search phrase.
async function tracksForSuggestions(account: ProviderAccountDocument, source: ProviderTrack, query?: string) {
    const text = query?.trim()
    if (!text) {
        return rankSimilarTracks(source, await searchSuggestionCandidates(account, source), suggestionLimit).map((item) => item.track)
    }
    const parsed = parseCatalogSearchLabel(account.provider, text)
    const adapter = getAccountAdapter(account)
    const candidates = await adapter.searchTrackCandidates(account, {...source, title: parsed.title, artists: parsed.artists, isrc: undefined})
    return firstUniqueTracks(candidates, suggestionLimit)
}

async function resolveUnmatchedReference(task: SyncTaskDocument, identity: UnmatchedTrackIdentity): Promise<SyncRunTrackReference> {
    const db = await collections()
    const runId = identity.runId && ObjectId.isValid(identity.runId) ? new ObjectId(identity.runId) : undefined
    const run: SyncRunDocument | null = runId ? await db.syncRuns.findOne({_id: runId, taskId: task._id}) : await db.syncRuns.findOne({taskId: task._id, status: {$ne: "running"}}, {sort: {startedAt: -1}})
    const fromRun = run?.unmatchedTracks.find((track) => unmatchedTrackMatches(track, identity))
    const snapshots = await loadTaskSnapshots(task._id!)
    const flattened = combinedSnapshot(snapshots)
    const fromSnapshot = flattened ? unmatchedTracksFromSnapshot(flattened, task).find((track) => unmatchedTrackMatches(track, identity)) : undefined
    const unmatched = fromSnapshot || fromRun
    if (!unmatched) {
        throw createError({statusCode: 404, statusMessage: "Unmatched track was not found"})
    }
    return unmatched
}

function flippedMatchTarget(target: MatchTarget, unmatchedPlaylistId: string, unmatchedName: string): MatchTarget {
    return {
        unmatchedSide: target.targetSide,
        targetSide: target.unmatchedSide,
        targetPlaylistId: unmatchedPlaylistId,
        targetPlaylistName: unmatchedName || target.targetPlaylistName
    }
}

async function locateUnmatchedPlacement(task: SyncTaskDocument, identity: UnmatchedTrackIdentity, unmatched: SyncRunTrackReference) {
    const snapshots = await loadTaskSnapshots(task._id!)
    const flattened = combinedSnapshot(snapshots)
    let target: MatchTarget
    try {
        target = resolveMatchTarget(task, unmatched.playlistId)
    } catch {
        target = playlistPairTarget(task, "source")
    }
    const candidates = [
        {target, playlistId: unmatched.playlistId},
        {target: flippedMatchTarget(target, unmatched.playlistId, unmatched.playlistName || ""), playlistId: target.targetPlaylistId}
    ].filter((candidate) => candidate.playlistId && candidate.playlistId !== "__all__")
    for (const candidate of candidates) {
        const accountId = candidate.target.unmatchedSide === "source" ? task.source.providerAccountId : task.destination.providerAccountId
        const account = await loadAccount(accountId, task.userId)
        const live = (await getAccountAdapter(account).getPlaylistItems(account, candidate.playlistId)).find((track) => liveTrackMatches(track, identity))
        if (live) {
            const snapshotItems = snapshotItemsForPlaylist(snapshots, candidate.playlistId, candidate.target.unmatchedSide)
            return {target: candidate.target, unmatchedAccount: account, live, playlistId: candidate.playlistId, snapshot: flattened, snapshotItem: findSnapshotItem(snapshotItems, identity)}
        }
    }
    const fallback = candidates[0]
    const unmatchedAccount = await loadAccount((fallback?.target.unmatchedSide || target.unmatchedSide) === "source" ? task.source.providerAccountId : task.destination.providerAccountId, task.userId)
    const side = (fallback?.target.unmatchedSide || target.unmatchedSide) === "source" ? "source" : "destination"
    const snapshotItems = snapshotItemsForPlaylist(snapshots, fallback?.playlistId || unmatched.playlistId, side)
    return {
        target: fallback?.target || target,
        unmatchedAccount,
        live: undefined as ProviderTrack | undefined,
        playlistId: fallback?.playlistId || unmatched.playlistId,
        snapshot: flattened,
        snapshotItem: findSnapshotItem(snapshotItems, identity)
    }
}

// Rank similar catalog tracks on the other service for an unmatched playlist song.
export async function suggestMatchesForUnmatched(userId: ObjectId, taskId: ObjectId, identity: UnmatchedTrackIdentity): Promise<MatchSuggestionsResult> {
    const {task} = await loadOwnedTask(taskId, userId)
    await assertSyncTaskIdle(task)
    const unmatched = await resolveUnmatchedReference(task, identity)
    const placement = await locateUnmatchedPlacement(task, identity, unmatched)
    const targetAccount = await loadAccount(placement.target.targetSide === "source" ? task.source.providerAccountId : task.destination.providerAccountId, userId)
    const source = asSearchTrack(unmatched, placement.snapshotItem || (placement.live ? toCanonical(placement.live) : undefined))
    const query = suggestionQuery(targetAccount.provider, source, identity.query)
    const tracks = await tracksForSuggestions(targetAccount, source, identity.query)
    logger.info("Sync.suggestMatches", `Task ${taskId.toHexString()}`, `Unmatched ${source.title}`, `Query ${query}`, `Suggestions ${tracks.length}`)
    return {
        unmatched: {
            title: source.title,
            artists: source.artists,
            playlistName: unmatched.playlistName,
            ...(source.durationMs ? {durationMs: source.durationMs} : {})
        },
        targetProvider: targetAccount.provider,
        targetPlaylistName: placement.target.targetPlaylistName,
        query,
        suggestions: tracks.map((track) => serializeSuggestion(targetAccount.provider, track))
    }
}

// Move a matched song from a run's unmatched list onto its added list.
export function moveUnmatchedToAdded<T extends Pick<SyncRunDocument, "unmatchedTracks" | "addedTracks" | "additions" | "skipped" | "conflicts" | "status">>(run: T, identity: UnmatchedTrackIdentity, addedTrack: SyncRunTrackReference): T | null {
    // A running sync is still appending these lists, so a stale copy must not replace them.
    if (run.status === "running") return null
    const unmatchedTracks = [...run.unmatchedTracks]
    const index = unmatchedTracks.findIndex((track) => unmatchedTrackMatches(track, identity))
    if (index < 0) return null
    unmatchedTracks.splice(index, 1)
    const alreadyAdded = run.addedTracks.some((track) => track.playlistId === addedTrack.playlistId && track.providerTrackId === addedTrack.providerTrackId)
    const addedTracks = alreadyAdded ? run.addedTracks : [...run.addedTracks, addedTrack]
    const skipped = unmatchedTracks.length
    return {
        ...run,
        unmatchedTracks,
        addedTracks,
        additions: run.additions + (alreadyAdded ? 0 : 1),
        skipped,
        ...(run.status === "partial" && !skipped && !run.conflicts ? {status: "succeeded" as const} : {})
    }
}

async function recordManualMatchOnRuns(taskId: ObjectId, identity: UnmatchedTrackIdentity, addedTrack: SyncRunTrackReference) {
    const db = await collections()
    const runs = await db.syncRuns
        .find({
            taskId,
            status: {$ne: "running"},
            unmatchedTracks: {$elemMatch: {playlistId: identity.playlistId, providerTrackId: identity.providerTrackId}}
        })
        .toArray()
    for (const run of runs) {
        const next = moveUnmatchedToAdded(run, identity, addedTrack)
        if (!next) continue
        await db.syncRuns.updateOne(
            {_id: run._id, status: {$ne: "running"}},
            {
                $set: {
                    unmatchedTracks: next.unmatchedTracks,
                    addedTracks: next.addedTracks,
                    additions: next.additions,
                    skipped: next.skipped,
                    status: next.status
                }
            }
        )
    }
}

// Remember a full-sync stand-in so the next mirror keeps that pair linked.
async function saveAccountManualAlias(task: SyncTaskDocument, unmatchedPlaylistId: string, targetPlaylistId: string, alias: ManualTrackAlias, leaseId: string) {
    if (!task._id) return
    const db = await collections()
    const stored = await db.syncTasks.findOne({_id: task._id}, {projection: {playlistMappings: 1}})
    const mappings = (stored?.playlistMappings || []).map((item) => ({...item, ...(item.manualAliases ? {manualAliases: item.manualAliases.map((saved) => ({...saved}))} : {})}))
    const mapping = mappings.find((item) => [item.sourcePlaylistId, item.destinationPlaylistId].includes(unmatchedPlaylistId) || [item.sourcePlaylistId, item.destinationPlaylistId].includes(targetPlaylistId))
    if (!mapping) return
    mapping.manualAliases = [...(mapping.manualAliases || []).filter((item) => item.canonicalKey !== alias.canonicalKey && item.sourceTrackId !== alias.sourceTrackId), alias]
    // Only the holder of the caller's task lease can write, so a sync that took over keeps its mappings.
    await saveMergedPlaylistMappings(task._id, mappings, {replaceAliases: true, leaseId})
}

// Give a snapshot row the shared key, or add the row when the snapshot does not have that track yet.
export function linkSnapshotRow(items: CanonicalTrack[], track: ProviderTrack, sharedKey: string): CanonicalTrack[] {
    const existing = findSnapshotItem(items, {providerItemId: track.itemId, providerTrackId: track.trackId})
    if (!existing) {
        return [...items, toCanonical({...track, canonicalKey: sharedKey})]
    }
    return items.map((item) => (item === existing ? {...item, canonicalKey: sharedKey} : item))
}

// Add the chosen catalog track and alias both sides so later syncs treat them as one song.
// The task lease is held throughout, so a sync cannot start in between and overwrite the link.
export async function applyManualMatch(userId: ObjectId, taskId: ObjectId, identity: UnmatchedTrackIdentity & {candidateTrackId: string}): Promise<ManualMatchResult> {
    if (isSafeModeEnabled()) {
        throw createError({statusCode: 503, statusMessage: safeModeWriteBlockedMessage})
    }
    const {db, task} = await loadOwnedTask(taskId, userId)
    return withTaskLease(task, async (lease) => {
        const unmatched = await resolveUnmatchedReference(task, identity)
        const placement = await locateUnmatchedPlacement(task, identity, unmatched)
        const liveUnmatched = placement.live
        if (!liveUnmatched) {
            throw createError({statusCode: 409, statusMessage: "This track is no longer in the playlist"})
        }
        const targetAccount = await loadAccount(placement.target.targetSide === "source" ? task.source.providerAccountId : task.destination.providerAccountId, userId)
        const unmatchedAdapter = getAccountAdapter(placement.unmatchedAccount)
        const targetAdapter = getAccountAdapter(targetAccount)
        const source = asSearchTrack(unmatched, placement.snapshotItem || toCanonical(liveUnmatched))
        const candidates = await tracksForSuggestions(targetAccount, source, identity.query)
        const chosen = candidates.find((track) => track.trackId === identity.candidateTrackId)
        if (!chosen) {
            throw createError({statusCode: 400, statusMessage: "That suggestion is no longer available"})
        }
        const targetItems = await targetAdapter.getPlaylistItems(targetAccount, placement.target.targetPlaylistId)
        const existing = targetItems.find((track) => track.trackId === chosen.trackId)
        let added = false
        let addedIds: {providerTrackId: string; providerItemId?: string} = {providerTrackId: chosen.trackId, providerItemId: existing?.itemId}
        if (!existing) {
            await lease.assertHeld()
            await targetAdapter.addTracks(targetAccount, placement.target.targetPlaylistId, [chosen.trackId], async (tracks) => {
                addedIds = tracks[0] || addedIds
            })
            added = true
        }
        const [verifiedUnmatched, verifiedTarget] = await Promise.all([unmatchedAdapter.getPlaylistItems(placement.unmatchedAccount, placement.playlistId), targetAdapter.getPlaylistItems(targetAccount, placement.target.targetPlaylistId)])
        const addedLive = verifiedTarget.find((track) => track.trackId === chosen.trackId) || existing
        if (!addedLive) {
            throw createError({statusCode: 502, statusMessage: "The selected track could not be added"})
        }
        const addedTrack = {...addedLive, itemId: addedLive.itemId || addedIds.providerItemId || addedLive.trackId}
        const sharedKey = placement.snapshotItem?.canonicalKey || trackKey(liveUnmatched)
        await lease.assertHeld()
        if (task.mode === "account") {
            await saveAccountManualAlias(
                task,
                unmatched.playlistId,
                placement.target.targetPlaylistId,
                {
                    sourceTrackId: placement.target.unmatchedSide === "source" ? liveUnmatched.trackId : addedTrack.trackId,
                    sourceItemId: placement.target.unmatchedSide === "source" ? liveUnmatched.itemId : addedTrack.itemId,
                    destinationTrackId: placement.target.unmatchedSide === "source" ? addedTrack.trackId : liveUnmatched.trackId,
                    destinationItemId: placement.target.unmatchedSide === "source" ? addedTrack.itemId : liveUnmatched.itemId,
                    canonicalKey: sharedKey
                },
                lease.leaseId
            )
        } else {
            const stored = await db.syncSnapshots.findOne({taskId: task._id!})
            const unmatchedField = placement.target.unmatchedSide === "source" ? "sourceItems" : "destinationItems"
            const targetField = placement.target.unmatchedSide === "source" ? "destinationItems" : "sourceItems"
            if (stored) {
                // Only the two linked rows change. Rebuilding the snapshot from live playlists would hide unsynced edits from the next two-way run.
                await db.syncSnapshots.updateOne(
                    {taskId: task._id!},
                    {$set: {[unmatchedField]: linkSnapshotRow(stored[unmatchedField], liveUnmatched, sharedKey), [targetField]: linkSnapshotRow(stored[targetField], addedTrack, sharedKey), createdAt: new Date()}}
                )
            } else {
                const aliases = manualMatchAliases(null, {providerItemId: liveUnmatched.itemId, providerTrackId: liveUnmatched.trackId}, {providerItemId: addedTrack.itemId, providerTrackId: addedTrack.trackId}, sharedKey)
                const available = (items: ProviderTrack[]) => items.filter((item) => !item.unavailable)
                await db.syncSnapshots.updateOne(
                    {taskId: task._id!},
                    {$set: {[unmatchedField]: canonicalItemsWithAliases(available(verifiedUnmatched), aliases), [targetField]: canonicalItemsWithAliases(available(verifiedTarget), aliases), createdAt: new Date()}},
                    {upsert: true}
                )
            }
        }
        await recordManualMatchOnRuns(task._id!, identity, {
            providerAccountId: targetAccount._id!,
            playlistId: placement.target.targetPlaylistId,
            playlistName: placement.target.targetPlaylistName,
            providerTrackId: addedTrack.trackId,
            providerItemId: addedTrack.itemId,
            title: chosen.title,
            artists: chosen.artists,
            ...(chosen.durationMs ? {durationMs: chosen.durationMs} : {})
        })
        logger.info("Sync.manualMatch", `Task ${taskId.toHexString()}`, added ? "Added" : "Linked existing", chosen.title, `Linked ${sharedKey}`)
        return {added, linked: true, title: chosen.title, artists: chosen.artists}
    })
}
