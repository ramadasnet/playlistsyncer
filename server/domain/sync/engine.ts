import {randomUUID} from "node:crypto"
import {ObjectId} from "mongodb"
import type {
    CanonicalTrack,
    PlaylistMapping,
    ProviderAccountDocument,
    SyncRunTrackReference,
    SyncTaskDocument
} from "~~/shared/types/domain"
import {resolvedTaskDirection} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {resolveEntitlement} from "../billing/entitlement"
import {getProviderAdapter, type ProviderPlaylist, type ProviderTrack} from "../providers"
import {trackMatchingVersion} from "../providers/matching"
import {commonTracks, reconcileOneWay, reconcileThreeWay, trackKey, type ReconciledTrack} from "./reconcile"

const leaseDurationMs = 15 * 60 * 1000

interface RecordedTrackChanges {
    addedTracks?: SyncRunTrackReference[]
    removedTracks?: SyncRunTrackReference[]
}

type RecordTrackChanges = (changes: RecordedTrackChanges) => Promise<void>

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

function countTracks(tracks: ProviderTrack[]): Map<string, ProviderTrack[]> {
    const result = new Map<string, ProviderTrack[]>()
    for (const track of tracks) {
        const key = trackKey(track)
        result.set(key, [...(result.get(key) || []), track])
    }
    return result
}

function aliasMap(items: CanonicalTrack[]): Map<string, string> {
    return new Map(
        items.flatMap((item) => [
            [item.providerItemId, item.canonicalKey],
            [item.providerTrackId, item.canonicalKey]
        ])
    )
}

function applyAliases(tracks: ProviderTrack[], aliases: Map<string, string>): ProviderTrack[] {
    return tracks.map((track) => ({...track, canonicalKey: aliases.get(track.itemId) || aliases.get(track.trackId)}))
}

function trackReferences(
    account: ProviderAccountDocument,
    playlistId: string,
    tracks: Pick<ProviderTrack, "trackId" | "itemId" | "title" | "artists">[]
): SyncRunTrackReference[] {
    return tracks.map((track) => ({
        providerAccountId: account._id!,
        playlistId,
        providerTrackId: track.trackId,
        providerItemId: track.itemId,
        title: track.title,
        artists: track.artists
    }))
}

async function applyDesired(
    account: ProviderAccountDocument,
    playlistId: string,
    current: ProviderTrack[],
    desired: ReconciledTrack[],
    recordChanges: RecordTrackChanges
): Promise<{
    additions: number
    removals: number
    skipped: number
    aliases: {trackId: string; canonicalKey: string}[]
}> {
    const adapter = getProviderAdapter(account.provider)
    const currentByKey = countTracks(current)
    const desiredByKey = new Map(desired.map((track) => [track.key, track]))
    const removals: string[] = []
    const additions: {trackId: string; canonicalKey: string; title: string; artists: string[]}[] = []
    let skipped = 0

    for (const [key, occurrences] of currentByKey) {
        const desiredCount = desiredByKey.get(key)?.count || 0
        removals.push(...occurrences.slice(desiredCount).map((track) => track.itemId))
    }
    for (const desiredTrack of desired) {
        const missing = desiredTrack.count - (currentByKey.get(desiredTrack.key)?.length || 0)
        for (let count = 0; count < missing; count++) {
            const match = await adapter.searchTrack(account, desiredTrack.reference)
            if (match) {
                additions.push({
                    trackId: match.trackId,
                    canonicalKey: desiredTrack.key,
                    title: match.title,
                    artists: match.artists
                })
            } else {
                skipped++
            }
        }
    }
    if (additions.length || removals.length || skipped) {
        logger.info(
            "Sync.applyDesired",
            account.provider,
            `Playlist ${playlistId}`,
            `Additions ${additions.length}`,
            `Removals ${removals.length}`,
            `Unmatched ${skipped}`
        )
    }
    if (removals.length) {
        await adapter.removePlaylistItems(account, playlistId, removals, async (removedItemIds) => {
            const removedIds = new Set(removedItemIds)
            await recordChanges({
                removedTracks: trackReferences(
                    account,
                    playlistId,
                    current.filter((track) => removedIds.has(track.itemId))
                )
            })
        })
    }
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
                        return {
                            providerAccountId: account._id!,
                            playlistId,
                            providerTrackId: track.providerTrackId,
                            providerItemId: track.providerItemId,
                            title: match?.title,
                            artists: match?.artists
                        }
                    })
                })
            }
        )
    }
    return {additions: additions.length, removals: removals.length, skipped, aliases: additions}
}

async function loadAccount(id: ObjectId, userId: ObjectId): Promise<ProviderAccountDocument> {
    const db = await collections()
    const account = await db.providerAccounts.findOne({_id: id, userId})
    if (!account) {
        throw createError({statusCode: 409, statusMessage: "A connected provider account is missing"})
    }
    return account
}

async function executePlaylist(task: SyncTaskDocument, recordChanges: RecordTrackChanges) {
    const db = await collections()
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourceItems, destinationItems, snapshot] = await Promise.all([
        sourceAdapter.getPlaylistItems(sourceAccount, task.source.playlistId),
        destinationAdapter.getPlaylistItems(destinationAccount, task.destination.playlistId),
        db.syncSnapshots.findOne({taskId: task._id!})
    ])
    const currentSnapshot = snapshot?.matchingVersion === trackMatchingVersion ? snapshot : null
    const oneWay = resolvedTaskDirection(task) === "one-way"
    logger.info(
        "Sync.execute",
        `Task ${task._id!.toHexString()}`,
        `${sourceAccount.provider} items ${sourceItems.length}`,
        `${destinationAccount.provider} items ${destinationItems.length}`,
        currentSnapshot
            ? oneWay
                ? "Mirror run"
                : "Reconciliation run"
            : snapshot
              ? "Matching upgrade run"
              : "Initial run"
    )

    let sourceResult = {additions: 0, removals: 0, skipped: 0, aliases: [] as {trackId: string; canonicalKey: string}[]}
    let destinationResult = {
        additions: 0,
        removals: 0,
        skipped: 0,
        aliases: [] as {trackId: string; canonicalKey: string}[]
    }
    let conflicts: string[] = []
    if (!currentSnapshot) {
        const desired = reconcileOneWay(sourceItems).desired
        if (destinationItems.length) {
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
                            })
                        )
                    })
                }
            )
        }
        destinationResult = await applyDesired(
            destinationAccount,
            task.destination.playlistId,
            [],
            desired,
            recordChanges
        )
        destinationResult.removals = destinationItems.length
    } else {
        const sourceAliases = aliasMap(currentSnapshot.sourceItems)
        const destinationAliases = aliasMap(currentSnapshot.destinationItems)
        const aliasedSource = applyAliases(sourceItems, sourceAliases)
        const aliasedDestination = applyAliases(destinationItems, destinationAliases)
        if (oneWay) {
            destinationResult = await applyDesired(
                destinationAccount,
                task.destination.playlistId,
                aliasedDestination,
                reconcileOneWay(aliasedSource).desired,
                recordChanges
            )
        } else {
            const baseline = commonTracks(
                currentSnapshot.sourceItems.map(fromCanonical),
                currentSnapshot.destinationItems.map(fromCanonical)
            )
            const reconciliation = reconcileThreeWay(baseline, aliasedSource, aliasedDestination)
            conflicts = reconciliation.conflicts
            if (conflicts.length) {
                logger.warn("Sync.reconcile", `Task ${task._id!.toHexString()}`, `Conflicts ${conflicts.length}`)
            }
            sourceResult = await applyDesired(
                sourceAccount,
                task.source.playlistId,
                aliasedSource,
                reconciliation.desired,
                recordChanges
            )
            destinationResult = await applyDesired(
                destinationAccount,
                task.destination.playlistId,
                aliasedDestination,
                reconciliation.desired,
                recordChanges
            )
        }
    }

    const [verifiedSource, verifiedDestination] = await Promise.all([
        sourceAdapter.getPlaylistItems(sourceAccount, task.source.playlistId),
        destinationAdapter.getPlaylistItems(destinationAccount, task.destination.playlistId)
    ])
    const desiredAliases = new Map<string, string>([
        ...(currentSnapshot
            ? [...aliasMap(currentSnapshot.sourceItems), ...aliasMap(currentSnapshot.destinationItems)]
            : []),
        ...sourceResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const),
        ...destinationResult.aliases.map((item) => [item.trackId, item.canonicalKey] as const)
    ])
    const normalizedAliases = new Map(
        [...countTracks(sourceItems)].map(([key, occurrences]) => [trackKey(occurrences[0]!), key] as const)
    )
    const canonicalize = (items: ProviderTrack[]) =>
        items.map((item) => ({
            ...item,
            canonicalKey:
                desiredAliases.get(item.itemId) ||
                desiredAliases.get(item.trackId) ||
                normalizedAliases.get(trackKey(item))
        }))
    await db.syncSnapshots.updateOne(
        {taskId: task._id!},
        {
            $set: {
                matchingVersion: trackMatchingVersion,
                sourceItems: canonicalize(verifiedSource).map(toCanonical),
                destinationItems: canonicalize(verifiedDestination).map(toCanonical),
                createdAt: new Date()
            }
        },
        {upsert: true}
    )
    return {
        additions: sourceResult.additions + destinationResult.additions,
        removals: sourceResult.removals + destinationResult.removals,
        skipped: sourceResult.skipped + destinationResult.skipped,
        conflicts: conflicts.length
    }
}

async function mirrorPlaylist(
    sourceAccount: ProviderAccountDocument,
    destinationAccount: ProviderAccountDocument,
    sourcePlaylistId: string,
    destinationPlaylistId: string,
    recordChanges: RecordTrackChanges
) {
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourceItems, destinationItems] = await Promise.all([
        sourceAdapter.getPlaylistItems(sourceAccount, sourcePlaylistId),
        destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylistId)
    ])
    return applyDesired(
        destinationAccount,
        destinationPlaylistId,
        destinationItems,
        reconcileOneWay(sourceItems).desired,
        recordChanges
    )
}

async function executeAccount(task: SyncTaskDocument, recordChanges: RecordTrackChanges) {
    const db = await collections()
    const sourceAccount = await loadAccount(task.source.providerAccountId, task.userId)
    const destinationAccount = await loadAccount(task.destination.providerAccountId, task.userId)
    const sourceAdapter = getProviderAdapter(sourceAccount.provider)
    const destinationAdapter = getProviderAdapter(destinationAccount.provider)
    const [sourcePlaylists, destinationPlaylists] = await Promise.all([
        sourceAdapter.listPlaylists(sourceAccount),
        destinationAdapter.listPlaylists(destinationAccount)
    ])
    const sourceIds = new Set(sourcePlaylists.map((playlist) => playlist.id))
    const destinationById = new Map(destinationPlaylists.map((playlist) => [playlist.id, playlist]))
    const mappings: PlaylistMapping[] = [...(task.playlistMappings || [])]
    const claimedDestinationIds = new Set(
        mappings
            .filter((mapping) => sourceIds.has(mapping.sourcePlaylistId))
            .map((mapping) => mapping.destinationPlaylistId)
    )
    const persistMappings = () =>
        db.syncTasks.updateOne({_id: task._id!}, {$set: {playlistMappings: mappings, updatedAt: new Date()}})
    let additions = 0
    let removals = 0
    let skipped = 0

    for (const sourcePlaylist of sourcePlaylists) {
        let mapping = mappings.find((item) => item.sourcePlaylistId === sourcePlaylist.id)
        let destinationPlaylist: ProviderPlaylist | undefined = mapping
            ? destinationById.get(mapping.destinationPlaylistId)
            : undefined
        if (!destinationPlaylist) {
            destinationPlaylist = destinationPlaylists.find(
                (playlist) => playlist.name === sourcePlaylist.name && !claimedDestinationIds.has(playlist.id)
            )
        }
        if (!destinationPlaylist) {
            destinationPlaylist = await destinationAdapter.createPlaylist(destinationAccount, sourcePlaylist.name)
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
        const result = await mirrorPlaylist(
            sourceAccount,
            destinationAccount,
            sourcePlaylist.id,
            destinationPlaylist.id,
            recordChanges
        )
        additions += result.additions
        removals += result.removals
        skipped += result.skipped
    }

    for (let index = mappings.length - 1; index >= 0; index--) {
        const mapping = mappings[index]!
        if (sourceIds.has(mapping.sourcePlaylistId)) continue
        const destinationPlaylist = destinationById.get(mapping.destinationPlaylistId)
        if (destinationPlaylist) {
            const removedItems = await destinationAdapter.getPlaylistItems(destinationAccount, destinationPlaylist.id)
            await destinationAdapter.deletePlaylist(destinationAccount, destinationPlaylist.id)
            await recordChanges({
                removedTracks: trackReferences(destinationAccount, destinationPlaylist.id, removedItems)
            })
            removals += destinationPlaylist.itemCount
        }
        mappings.splice(index, 1)
        await persistMappings()
    }

    logger.info(
        "Sync.executeAccount",
        `Task ${task._id!.toHexString()}`,
        `Playlists ${sourcePlaylists.length}`,
        `Additions ${additions}`,
        `Removals ${removals}`,
        `Unmatched ${skipped}`
    )
    return {additions, removals, skipped, conflicts: 0}
}

async function execute(task: SyncTaskDocument, recordChanges: RecordTrackChanges) {
    return task.mode === "account" ? executeAccount(task, recordChanges) : executePlaylist(task, recordChanges)
}

export async function runSyncTask(taskId: ObjectId, trigger: "created" | "manual" | "scheduled") {
    const db = await collections()
    const leaseId = randomUUID()
    const now = new Date()
    logger.info("Sync.run", `Task ${taskId.toHexString()}`, `Trigger ${trigger}`, "Acquiring lease")
    const task = await db.syncTasks.findOneAndUpdate(
        {
            _id: taskId,
            status: {$in: ["active", "needs_attention"]},
            $or: [{leaseExpiresAt: {$exists: false}}, {leaseExpiresAt: {$lt: now}}]
        },
        {$set: {leaseId, leaseExpiresAt: new Date(now.getTime() + leaseDurationMs)}},
        {returnDocument: "after"}
    )
    if (!task) {
        logger.warn("Sync.run", `Task ${taskId.toHexString()}`, "Task is paused, missing, or already leased")
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
        startedAt: now
    })
    logger.info("Sync.run", `Task ${taskId.toHexString()}`, `Run ${run.insertedId.toHexString()}`, "Started")
    const recordChanges: RecordTrackChanges = async ({addedTracks = [], removedTracks = []}) => {
        if (addedTracks.length) {
            await db.syncRuns.updateOne(
                {_id: run.insertedId},
                {$push: {addedTracks: {$each: addedTracks}}, $inc: {additions: addedTracks.length}}
            )
        }
        if (removedTracks.length) {
            await db.syncRuns.updateOne(
                {_id: run.insertedId},
                {$push: {removedTracks: {$each: removedTracks}}, $inc: {removals: removedTracks.length}}
            )
        }
    }
    try {
        const result = await execute(task, recordChanges)
        const user = await db.users.findOne({_id: task.userId})
        const nextRunMs =
            user && resolveEntitlement(user).tier === "pro" ? 12 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
        const finishedAt = new Date()
        await Promise.all([
            db.syncRuns.updateOne(
                {_id: run.insertedId},
                {$set: {...result, status: result.skipped || result.conflicts ? "partial" : "succeeded", finishedAt}}
            ),
            db.syncTasks.updateOne(
                {_id: taskId, leaseId},
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
        ])
        const log = result.skipped || result.conflicts ? logger.warn : logger.info
        log(
            "Sync.run",
            `Task ${taskId.toHexString()}`,
            `Run ${run.insertedId.toHexString()}`,
            `Additions ${result.additions}`,
            `Removals ${result.removals}`,
            `Conflicts ${result.conflicts}`,
            `Unmatched ${result.skipped}`,
            `Duration ${finishedAt.getTime() - now.getTime()}ms`
        )
        return result
    } catch (error) {
        const finishedAt = new Date()
        const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown synchronization error"
        await Promise.all([
            db.syncRuns.updateOne({_id: run.insertedId}, {$set: {status: "failed", error: message, finishedAt}}),
            db.syncTasks.updateOne(
                {_id: taskId, leaseId},
                {
                    $set: {lastRunAt: finishedAt, lastError: message, updatedAt: finishedAt},
                    $unset: {leaseId: "", leaseExpiresAt: ""}
                }
            )
        ])
        logger.error(
            "Sync.run",
            `Task ${taskId.toHexString()}`,
            `Run ${run.insertedId.toHexString()}`,
            `Duration ${finishedAt.getTime() - now.getTime()}ms`,
            error
        )
        throw error
    }
}
