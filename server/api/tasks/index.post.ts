// Validate and create a sync task, then start its first run asynchronously.
import type {ObjectId} from "mongodb"
import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {getProviderAdapter} from "../../domain/providers"
import {accountSyncPairField} from "../../domain/sync/account-sync-pair"
import {runSyncTask} from "../../domain/sync/engine"
import {isSafeModeEnabled, logSafeModeCreatePlaylist, safeModeWriteBlockedMessage} from "../../domain/sync/safe-mode"
import logger from "../../utils/logger"
import {isDuplicateKeyError} from "../../utils/mongodb"
import {parseObjectId} from "../../utils/object-id"
import {accountSyncConflictMessage, accountSyncProviderPairKey, findAccountSyncBetweenProviders, type SyncTaskDirection} from "~~/shared/types/domain"

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

// Enforce ownership and plan limits before persisting the task.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const entitlement = resolveEntitlement(user)
    const body = taskSchema.parse(await readBody(event))
    const sourceAccountId = parseObjectId(body.source.accountId, "source account")
    const destinationAccountId = parseObjectId(body.destination.accountId, "destination account")
    if (sourceAccountId.equals(destinationAccountId)) {
        logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Source and destination account are identical")
        throw createError({statusCode: 400, statusMessage: "Choose two different provider accounts"})
    }
    const db = await collections()
    const accounts = await db.providerAccounts.find({_id: {$in: [sourceAccountId, destinationAccountId]}, userId: user._id!}).toArray()
    if (accounts.length !== 2) {
        logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, "Selected account ownership check failed")
        throw createError({statusCode: 403, statusMessage: "A selected provider account does not belong to this user"})
    }
    const sourceAccount = accounts.find((account) => account._id?.equals(sourceAccountId))!
    const destinationAccount = accounts.find((account) => account._id?.equals(destinationAccountId))!
    const accountTasks = await db.syncTasks.find({userId: user._id!, mode: "account"}).toArray()
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
    // The sparse unique index on {userId, accountSyncPairKey} is the source of truth for provider-pair
    // uniqueness; the earlier read-then-check is only a fast path for a friendlier error message.
    const accountSyncPairKey = accountSyncProviderPairKey(sourceAccount.provider, destinationAccount.provider)
    let result: {insertedId: ObjectId}
    try {
        result = await db.syncTasks.insertOne({
            userId: user._id!,
            mode: body.mode,
            direction,
            ...accountSyncPairField(body.mode, accountSyncPairKey),
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
        })
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            logger.warn("Tasks.create", `User ${user._id!.toHexString()}`, `Account sync already exists between ${sourceAccount.provider} and ${destinationAccount.provider}`)
            throw createError({statusCode: 409, statusMessage: accountSyncConflictMessage({sourceProvider: sourceAccount.provider, destinationProvider: destinationAccount.provider})})
        }
        throw error
    }
    logger.info("Tasks.create", `Task ${result.insertedId.toHexString()}`, `User ${user._id!.toHexString()}`, `${accounts[0]!.provider} to ${accounts[1]!.provider}`, direction)
    event.waitUntil(
        runSyncTask(result.insertedId, "created").catch((error) => {
            logger.error("Tasks.createRun", `Task ${result.insertedId.toHexString()}`, error)
        })
    )
    setResponseStatus(event, 201)
    return {id: result.insertedId.toHexString()}
})
