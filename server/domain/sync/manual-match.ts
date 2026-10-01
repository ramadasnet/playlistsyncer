// Suggest similar catalog tracks and persist a manual match so later syncs keep the pair.
import {ObjectId} from "mongodb"
import type {CanonicalTrack, ManualTrackAlias, ProviderAccountDocument, SyncRunDocument, SyncRunTrackReference, SyncSnapshotDocument, SyncTaskDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {getProviderAdapter, type ProviderTrack} from "../providers"
import {rankSimilarTracks} from "../providers/matching"
import {unmatchedTracksFromSnapshot} from "./history-visibility"
import {saveMergedPlaylistMappings} from "./playlist-mappings"
import {isSafeModeEnabled, safeModeWriteBlockedMessage} from "./safe-mode"
import {assertSyncTaskIdle} from "./task-activity"
import {trackKey} from "./reconcile"

export interface UnmatchedTrackIdentity {
    playlistId: string
    providerTrackId: string
    providerItemId?: string
    runId?: string
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
}

export interface MatchSuggestionsResult {
    unmatched: {title: string; artists: string[]; playlistName?: string; durationMs?: number}
    targetProvider: ProviderAccountDocument["provider"]
    targetPlaylistName: string
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
    return items.find((item) => (identity.providerItemId && item.providerItemId === identity.providerItemId) || item.providerTrackId === identity.providerTrackId)
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

function serializeSuggestion(track: ProviderTrack): SimilarTrackSuggestion {
    return {
        trackId: track.trackId,
        title: track.title,
        artists: track.artists,
        ...(track.album ? {album: track.album} : {}),
        ...(track.durationMs ? {durationMs: track.durationMs} : {}),
        ...(track.imageUrl ? {imageUrl: track.imageUrl} : {})
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

// Pull catalog candidates, retrying without ISRC so near-matches can still surface.
async function searchSuggestionCandidates(account: ProviderAccountDocument, source: ProviderTrack) {
    const adapter = getProviderAdapter(account.provider)
    const primary = await adapter.searchTrackCandidates(account, source)
    if (!source.isrc) {
        return primary
    }
    const byTitle = await adapter.searchTrackCandidates(account, {...source, isrc: undefined})
    return [...primary, ...byTitle]
}

async function resolveUnmatchedReference(task: SyncTaskDocument, identity: UnmatchedTrackIdentity): Promise<SyncRunTrackReference> {
    const db = await collections()
    const runId = identity.runId && ObjectId.isValid(identity.runId) ? new ObjectId(identity.runId) : undefined
    const run: SyncRunDocument | null = runId ? await db.syncRuns.findOne({_id: runId, taskId: task._id}) : await db.syncRuns.findOne({taskId: task._id, status: {$ne: "running"}}, {sort: {startedAt: -1}})
    const fromRun = run?.unmatchedTracks.find((track) => unmatchedTrackMatches(track, identity))
    const snapshot = await db.syncSnapshots.findOne({taskId: task._id})
    const fromSnapshot = snapshot ? unmatchedTracksFromSnapshot(snapshot, task).find((track) => unmatchedTrackMatches(track, identity)) : undefined
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
    const db = await collections()
    const snapshot = await db.syncSnapshots.findOne({taskId: task._id})
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
        const live = (await getProviderAdapter(account.provider).getPlaylistItems(account, candidate.playlistId)).find((track) => liveTrackMatches(track, identity))
        if (live) {
            const snapshotItems = candidate.target.unmatchedSide === "source" ? snapshot?.sourceItems || [] : snapshot?.destinationItems || []
            return {target: candidate.target, unmatchedAccount: account, live, playlistId: candidate.playlistId, snapshot, snapshotItem: findSnapshotItem(snapshotItems, identity)}
        }
    }
    const fallback = candidates[0]
    const unmatchedAccount = await loadAccount((fallback?.target.unmatchedSide || target.unmatchedSide) === "source" ? task.source.providerAccountId : task.destination.providerAccountId, task.userId)
    const snapshotItems = (fallback?.target.unmatchedSide || target.unmatchedSide) === "source" ? snapshot?.sourceItems || [] : snapshot?.destinationItems || []
    return {
        target: fallback?.target || target,
        unmatchedAccount,
        live: undefined as ProviderTrack | undefined,
        playlistId: fallback?.playlistId || unmatched.playlistId,
        snapshot,
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
    const ranked = rankSimilarTracks(source, await searchSuggestionCandidates(targetAccount, source))
    logger.info("Sync.suggestMatches", `Task ${taskId.toHexString()}`, `Unmatched ${source.title}`, `Suggestions ${ranked.length}`)
    return {
        unmatched: {
            title: source.title,
            artists: source.artists,
            playlistName: unmatched.playlistName,
            ...(source.durationMs ? {durationMs: source.durationMs} : {})
        },
        targetProvider: targetAccount.provider,
        targetPlaylistName: placement.target.targetPlaylistName,
        suggestions: ranked.map((item) => serializeSuggestion(item.track))
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
async function saveAccountManualAlias(task: SyncTaskDocument, unmatchedPlaylistId: string, targetPlaylistId: string, alias: ManualTrackAlias) {
    if (!task._id) return
    const db = await collections()
    const stored = await db.syncTasks.findOne({_id: task._id}, {projection: {playlistMappings: 1}})
    const mappings = (stored?.playlistMappings || []).map((item) => ({...item, ...(item.manualAliases ? {manualAliases: item.manualAliases.map((saved) => ({...saved}))} : {})}))
    const mapping = mappings.find((item) => [item.sourcePlaylistId, item.destinationPlaylistId].includes(unmatchedPlaylistId) || [item.sourcePlaylistId, item.destinationPlaylistId].includes(targetPlaylistId))
    if (!mapping) return
    mapping.manualAliases = [...(mapping.manualAliases || []).filter((item) => item.canonicalKey !== alias.canonicalKey && item.sourceTrackId !== alias.sourceTrackId), alias]
    await saveMergedPlaylistMappings(task._id, mappings)
}

// Add the chosen catalog track and alias both sides so later syncs treat them as one song.
export async function applyManualMatch(userId: ObjectId, taskId: ObjectId, identity: UnmatchedTrackIdentity & {candidateTrackId: string}): Promise<ManualMatchResult> {
    if (isSafeModeEnabled()) {
        throw createError({statusCode: 503, statusMessage: safeModeWriteBlockedMessage})
    }
    const {db, task} = await loadOwnedTask(taskId, userId)
    await assertSyncTaskIdle(task)
    const unmatched = await resolveUnmatchedReference(task, identity)
    const placement = await locateUnmatchedPlacement(task, identity, unmatched)
    const liveUnmatched = placement.live
    if (!liveUnmatched) {
        throw createError({statusCode: 409, statusMessage: "This track is no longer in the playlist"})
    }
    const targetAccount = await loadAccount(placement.target.targetSide === "source" ? task.source.providerAccountId : task.destination.providerAccountId, userId)
    const unmatchedAdapter = getProviderAdapter(placement.unmatchedAccount.provider)
    const targetAdapter = getProviderAdapter(targetAccount.provider)
    const source = asSearchTrack(unmatched, placement.snapshotItem || toCanonical(liveUnmatched))
    const ranked = rankSimilarTracks(source, await searchSuggestionCandidates(targetAccount, source))
    const chosen = ranked.find((item) => item.track.trackId === identity.candidateTrackId)
    if (!chosen) {
        throw createError({statusCode: 400, statusMessage: "That suggestion is no longer available"})
    }
    const targetItems = await targetAdapter.getPlaylistItems(targetAccount, placement.target.targetPlaylistId)
    const existing = targetItems.find((track) => track.trackId === chosen.track.trackId)
    let added = false
    let addedIds: {providerTrackId: string; providerItemId?: string} = {providerTrackId: chosen.track.trackId, providerItemId: existing?.itemId}
    if (!existing) {
        await targetAdapter.addTracks(targetAccount, placement.target.targetPlaylistId, [chosen.track.trackId], async (tracks) => {
            addedIds = tracks[0] || addedIds
        })
        added = true
    }
    const [verifiedUnmatched, verifiedTarget] = await Promise.all([unmatchedAdapter.getPlaylistItems(placement.unmatchedAccount, placement.playlistId), targetAdapter.getPlaylistItems(targetAccount, placement.target.targetPlaylistId)])
    const addedLive = verifiedTarget.find((track) => track.trackId === chosen.track.trackId) || existing
    if (!addedLive) {
        throw createError({statusCode: 502, statusMessage: "The selected track could not be added"})
    }
    const sharedKey = placement.snapshotItem?.canonicalKey || trackKey(liveUnmatched)
    if (task.mode === "account") {
        await saveAccountManualAlias(task, unmatched.playlistId, placement.target.targetPlaylistId, {
            sourceTrackId: placement.target.unmatchedSide === "source" ? liveUnmatched.trackId : addedLive.trackId,
            sourceItemId: placement.target.unmatchedSide === "source" ? liveUnmatched.itemId : addedLive.itemId || addedIds.providerItemId,
            destinationTrackId: placement.target.unmatchedSide === "source" ? addedLive.trackId : liveUnmatched.trackId,
            destinationItemId: placement.target.unmatchedSide === "source" ? addedLive.itemId || addedIds.providerItemId : liveUnmatched.itemId,
            canonicalKey: sharedKey
        })
    } else {
        const aliases = manualMatchAliases(
            placement.snapshot,
            {providerItemId: liveUnmatched.itemId, providerTrackId: liveUnmatched.trackId},
            {providerItemId: addedLive.itemId || addedIds.providerItemId, providerTrackId: addedLive.trackId},
            sharedKey
        )
        const sourceItems = canonicalItemsWithAliases(placement.target.unmatchedSide === "source" ? verifiedUnmatched : verifiedTarget, aliases)
        const destinationItems = canonicalItemsWithAliases(placement.target.unmatchedSide === "source" ? verifiedTarget : verifiedUnmatched, aliases)
        await db.syncSnapshots.updateOne(
            {taskId: task._id!},
            {
                $set: {
                    sourceItems,
                    destinationItems,
                    createdAt: new Date()
                }
            },
            {upsert: true}
        )
    }
    await recordManualMatchOnRuns(task._id!, identity, {
        providerAccountId: targetAccount._id!,
        playlistId: placement.target.targetPlaylistId,
        playlistName: placement.target.targetPlaylistName,
        providerTrackId: addedLive.trackId,
        providerItemId: addedLive.itemId || addedIds.providerItemId,
        title: chosen.track.title,
        artists: chosen.track.artists,
        ...(chosen.track.durationMs ? {durationMs: chosen.track.durationMs} : {})
    })
    logger.info("Sync.manualMatch", `Task ${taskId.toHexString()}`, added ? "Added" : "Linked existing", chosen.track.title, `Linked ${sharedKey}`)
    return {added, linked: true, title: chosen.track.title, artists: chosen.track.artists}
}
