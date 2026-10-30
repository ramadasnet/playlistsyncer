// Describe the linked user and the sync tasks that run in the browser extension.
import type {ExtensionMeResponse} from "~~/shared/types/extension"
import {collections} from "../../data/collections"
import {requireExtensionClient} from "../../domain/extension/clients"

export default defineEventHandler(async (event): Promise<ExtensionMeResponse> => {
    const {user} = await requireExtensionClient(event)
    const db = await collections()
    const tasks = await db.syncTasks.find({userId: user._id!, browserExtension: true}).sort({createdAt: 1}).limit(50).toArray()
    const runs = tasks.length ? await db.syncRuns.aggregate<{_id: unknown; status: string}>([{$match: {taskId: {$in: tasks.map((task) => task._id!)}}}, {$sort: {startedAt: -1}}, {$group: {_id: "$taskId", status: {$first: "$status"}}}]).toArray() : []
    const runStatus = new Map(runs.map((run) => [String(run._id), run.status]))
    return {
        user: {name: user.displayName, ...(user.email ? {email: user.email} : {})},
        tasks: tasks.map((task) => ({
            id: task._id!.toHexString(),
            name: task.source.name === task.destination.name ? task.source.name : `${task.source.name} → ${task.destination.name}`,
            status: task.status,
            ...(task.lastRunAt ? {lastRunAt: task.lastRunAt.toISOString()} : {}),
            ...(runStatus.get(task._id!.toHexString()) ? {lastRunStatus: runStatus.get(task._id!.toHexString())} : {})
        }))
    }
})
