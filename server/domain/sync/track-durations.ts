// Load missing track lengths from music providers for stored run history.
import type {ObjectId} from "mongodb"
import type {SyncRunDocument, SyncRunTrackReference} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import logger from "../../utils/logger"
import {getProviderAdapter} from "../providers"
import {trackIdsForProvider} from "../providers/track-ids"
import {withTrackDurations} from "./history-visibility"

function runTracks(run: SyncRunDocument): SyncRunTrackReference[] {
    return [...run.addedTracks, ...run.removedTracks, ...run.unmatchedTracks]
}

function attachedNewDurations(before: SyncRunTrackReference[], after: SyncRunTrackReference[]) {
    return after.some((track, index) => Boolean(track.durationMs) && !before[index]?.durationMs)
}

// Fetch catalog durations for run tracks that were stored without length.
export async function fillMissingRunTrackDurations(userId: ObjectId, runs: SyncRunDocument[], extraAccountIds: ObjectId[] = []): Promise<SyncRunDocument[]> {
    const missing = runs.flatMap((run) => runTracks(run).filter((track) => !track.durationMs && track.providerTrackId))
    if (!missing.length) {
        return runs
    }
    const db = await collections()
    const accountIds = [...new Map([...missing.map((track) => track.providerAccountId), ...extraAccountIds].map((id) => [id.toHexString(), id])).values()]
    const accounts = await db.providerAccounts.find({_id: {$in: accountIds}, userId}).toArray()
    const durations = new Map<string, number>()
    const missingIds = [...new Set(missing.map((track) => track.providerTrackId))]
    for (const account of accounts) {
        const ids = trackIdsForProvider(account.provider, missingIds)
        if (!ids.length) {
            continue
        }
        try {
            const loaded = await getProviderAdapter(account.provider).getTrackDurations(account, ids)
            for (const [trackId, durationMs] of loaded) {
                durations.set(trackId, durationMs)
            }
        } catch (error) {
            logger.warn("Sync.trackDurations", account.provider, error)
        }
    }
    if (!durations.size) {
        return runs
    }
    return Promise.all(
        runs.map(async (run) => {
            const addedTracks = withTrackDurations(run.addedTracks, durations)
            const removedTracks = withTrackDurations(run.removedTracks, durations)
            const unmatchedTracks = withTrackDurations(run.unmatchedTracks, durations)
            if (!attachedNewDurations(run.addedTracks, addedTracks) && !attachedNewDurations(run.removedTracks, removedTracks) && !attachedNewDurations(run.unmatchedTracks, unmatchedTracks)) {
                return run
            }
            const next = {...run, addedTracks, removedTracks, unmatchedTracks}
            if (run._id) {
                await db.syncRuns.updateOne({_id: run._id}, {$set: {addedTracks, removedTracks, unmatchedTracks}})
            }
            return next
        })
    )
}
