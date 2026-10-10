// Validate and create a sync task, then start its first run asynchronously.
import type {ObjectId} from "mongodb"
import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {getProviderAdapter} from "../../domain/providers"
import {accountSyncPairField} from "../../domain/sync/account-sync-pair"
import {beginSyncTask, completeSyncTask} from "../../domain/sync/engine"
import {playlistWriteKey, storedPlaylistWriteKeys, writtenPlaylistRefs} from "../../domain/sync/playlist-writes"
import {isSafeModeEnabled, logSafeModeCreatePlaylist, safeModeWriteBlockedMessage} from "../../domain/sync/safe-mode"
import logger from "../../utils/logger"
import {duplicateKeyField, isDuplicateKeyError} from "../../utils/mongodb"
import {parseObjectId} from "../../utils/object-id"
import {startTrackedSyncRun} from "../../utils/shutdown"
import {accountSyncConflictMessage, accountSyncProviderPairKey, findAccountSyncBetweenProviders, type SyncTaskDirection, type SyncTaskDocument} from "~~/shared/types/domain"
import {enforceProviderRequestLimit} from "../../utils/user-rate-limit"
import {withUserLock} from "../../utils/user-lock"

const taskSchema = z.object({
    mode: z.enum(["playlist", "account"]).default("playlist"),
    direction: z.enum(["two-way", "one-way"]).default("one-way"),
    source: z.object({accountId: z.string(), playlistId: z.string().min(1), name: z.string().min(1).max(200), description: z.string().max(5000).optional()}),
    destination: z.object({
        accountId: z.string(),
        playlistId: z.string().min(1),
        name: z.string().min(1).max(200),
        createNew: z.boolean().default(false)
    })
})

const playlistWriteConflictMessage = "Another sync task already writes to this playlist. Pick another playlist or delete that task first."

// Enforce ownership and plan limits before persisting the task.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    enforceProviderRequestLimit(event, user._id!)
    const entitlement = resolveEntitlement(user)
    const body = taskSchema.parse(await readBody(event))
    const sourceAccountId = parseObjectId(body.source.accountId, "source account")
    const destinationAccountId = parseObjectId(body.destination.accountId, "destination account")
    if (sourceAccountId.equals(destinationAccountId)) {
        logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Source and destination account are identical")
        throw createError({statusCode: 400, statusMessage: "Choose two different provider accounts"})
    }
    // Hold this through the account check and insert so a disconnect cannot remove an account this task still points at.
    const taskId = await withUserLock(user._id!, async () => {
        const db = await collections()
        const accounts = await db.providerAccounts.find({_id: {$in: [sourceAccountId, destinationAccountId]}, userId: user._id!}).toArray()
        if (accounts.length !== 2) {
            logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Selected account ownership check failed")
            throw createError({statusCode: 403, statusMessage: "A selected provider account does not belong to this user"})
        }
        const sourceAccount = accounts.find((account) => account._id?.equals(sourceAccountId))!
        const destinationAccount = accounts.find((account) => account._id?.equals(destinationAccountId))!
        const userTasks = await db.syncTasks.find({userId: user._id!}).toArray()
        const accountTasks = userTasks.filter((task) => task.mode === "account")
        if (accountTasks.length) {
            const referencedIds = accountTasks.flatMap((task) => [task.source.providerAccountId, task.destination.providerAccountId])
            const referencedAccounts = await db.providerAccounts.find({_id: {$in: referencedIds}, userId: user._id!}).toArray()
            const providerByAccountId = new Map(referencedAccounts.flatMap((account) => (account._id ? [[account._id.toHexString(), account.provider] as const] : [])))
            const conflictingFullSync = findAccountSyncBetweenProviders(
                accountTasks.flatMap((task) => {
                    const taskSource = providerByAccountId.get(task.source.providerAccountId.toHexString())
                    const taskDestination = providerByAccountId.get(task.destination.providerAccountId.toHexString())
                    if (!taskSource || !taskDestination) return []
                    return [{mode: "account" as const, sourceProvider: taskSource, destinationProvider: taskDestination}]
                }),
                sourceAccount.provider,
                destinationAccount.provider
            )
            if (conflictingFullSync) {
                logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, `Account sync already exists from ${conflictingFullSync.sourceProvider} to ${conflictingFullSync.destinationProvider}`)
                throw createError({statusCode: 409, statusMessage: accountSyncConflictMessage(conflictingFullSync)})
            }
        }
        if (body.mode === "account" && entitlement.tier === "free") {
            logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Free tier account sync rejected")
            throw createError({statusCode: 403, statusMessage: "Synchronizing all playlists requires a PRO account"})
        }
        if (entitlement.tier === "free" && (await db.syncTasks.countDocuments({userId: user._id!})) >= 1) {
            logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Free tier task limit reached")
            throw createError({statusCode: 403, statusMessage: "Free accounts can synchronize one playlist pair"})
        }
        if (body.mode === "playlist") {
            // Two tasks writing one playlist would undo each other's changes on every run.
            const written = new Set(userTasks.flatMap((task) => writtenPlaylistRefs(task).map((ref) => playlistWriteKey(ref.providerAccountId, ref.playlistId))))
            const wanted = [...(body.destination.createNew ? [] : [playlistWriteKey(destinationAccountId, body.destination.playlistId)]), ...(body.direction === "two-way" ? [playlistWriteKey(sourceAccountId, body.source.playlistId)] : [])]
            if (wanted.some((key) => written.has(key))) {
                logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Another task already writes to the selected playlist")
                throw createError({statusCode: 409, statusMessage: playlistWriteConflictMessage})
            }
        }
        let destinationPlaylistId = body.destination.playlistId
        if (body.mode === "playlist" && body.destination.createNew) {
            // Creating a destination playlist is a provider write, so PLS_SAFE_MODE refuses the task.
            if (isSafeModeEnabled()) {
                logSafeModeCreatePlaylist(destinationAccount.provider, body.source.name)
                logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, safeModeWriteBlockedMessage)
                throw createError({statusCode: 503, statusMessage: safeModeWriteBlockedMessage})
            }
            const playlist = await getProviderAdapter(destinationAccount.provider).createPlaylist(destinationAccount, body.source.name, body.source.description)
            destinationPlaylistId = playlist.id
        }
        const direction: SyncTaskDirection = body.mode === "account" ? "one-way" : body.direction
        const now = new Date()
        // The single-field sparse unique index on accountSyncPairKey is the source of truth for one full
        // sync per user and provider pair. The earlier read is only a fast path for a friendlier error.
        const accountSyncPairKey = accountSyncProviderPairKey(sourceAccount.provider, destinationAccount.provider)
        const task: SyncTaskDocument = {
            userId: user._id!,
            mode: body.mode,
            direction,
            ...accountSyncPairField(body.mode, user._id!.toHexString(), accountSyncPairKey),
            source: {providerAccountId: sourceAccountId, playlistId: body.source.playlistId, name: body.source.name},
            destination: {
                providerAccountId: destinationAccountId,
                playlistId: destinationPlaylistId,
                name: body.destination.createNew ? body.source.name : body.destination.name
            },
            status: "active",
            nextRunAt: now,
            createdAt: now,
            updatedAt: now
        }
        const playlistWriteKeys = storedPlaylistWriteKeys(task)
        let result: {insertedId: ObjectId}
        try {
            // playlistWriteKeys is a sparse unique index, so a concurrent create of the same playlist loses the insert.
            result = await db.syncTasks.insertOne({...task, ...(playlistWriteKeys ? {playlistWriteKeys} : {})})
        } catch (error) {
            if (duplicateKeyField(error) === "playlistWriteKeys") {
                logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Another task already writes to the selected playlist")
                throw createError({statusCode: 409, statusMessage: playlistWriteConflictMessage})
            }
            if (isDuplicateKeyError(error)) {
                logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, `Account sync already exists between ${sourceAccount.provider} and ${destinationAccount.provider}`)
                throw createError({statusCode: 409, statusMessage: accountSyncConflictMessage({sourceProvider: sourceAccount.provider, destinationProvider: destinationAccount.provider})})
            }
            throw error
        }
        logger.info("Tasks.create", `Task ${result.insertedId.toHexString()}`, `User ${user._id!.toHexString()}`, `${accounts[0]!.provider} to ${accounts[1]!.provider}`, direction)
        return result.insertedId
    })
    event.waitUntil(
        startTrackedSyncRun(() => beginSyncTask(taskId, "created"), completeSyncTask)
            .then(({finished}) => finished)
            .catch((error) => {
                logger.error("Tasks.createRun", `Task ${taskId.toHexString()}`, error)
            })
    )
    setResponseStatus(event, 201)
    return {id: taskId.toHexString()}
})
