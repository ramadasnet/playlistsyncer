import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const db = await collections()
    const tasks = await db.syncTasks.find({userId: user._id!}).sort({createdAt: -1}).toArray()
    const taskIds = tasks.flatMap((task) => (task._id ? [task._id] : []))
    const runs = await db.syncRuns
        .find(
            {taskId: {$in: taskIds}},
            {projection: {taskId: 1, status: 1, additions: 1, removals: 1, conflicts: 1, skipped: 1, startedAt: 1}}
        )
        .sort({startedAt: -1})
        .toArray()
    const latestRun = new Map(runs.map((run) => [run.taskId.toHexString(), run]))
    return {
        tasks: tasks.map((task) => ({
            id: task._id?.toHexString(),
            mode: task.mode || "playlist",
            source: task.source,
            destination: task.destination,
            status: task.status,
            nextRunAt: task.nextRunAt,
            lastRunAt: task.lastRunAt,
            lastSuccessAt: task.lastSuccessAt,
            lastError: task.lastError,
            latestRun: task._id ? latestRun.get(task._id.toHexString()) : undefined
        }))
    }
})
