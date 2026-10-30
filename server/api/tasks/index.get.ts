// Return the user's sync tasks with the latest run counts.
import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {applyTaskEntitlement, isPlanLockedTask} from "../../domain/billing/task-entitlement"
import {serializeSyncTask} from "../../domain/sync/history-visibility"

// Refresh billing locks before serializing task state.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    await applyTaskEntitlement(user)
    const db = await collections()
    const tasks = await db.syncTasks.find({userId: user._id!}).sort({createdAt: -1}).toArray()
    const tier = resolveEntitlement(user).tier
    const taskIds = tasks.flatMap((task) => (task._id ? [task._id] : []))
    // One indexed lookup per task ({taskId: 1, startedAt: -1}) instead of loading every retained run just to keep the latest.
    const runs = await Promise.all(
        taskIds.map((taskId) =>
            db.syncRuns.findOne(
                {taskId},
                {
                    sort: {startedAt: -1},
                    projection: {
                        taskId: 1,
                        status: 1,
                        additions: 1,
                        removals: 1,
                        conflicts: 1,
                        skipped: 1,
                        startedAt: 1,
                        progress: 1
                    }
                }
            )
        )
    )
    const latestRun = new Map(runs.flatMap((run) => (run ? [[run.taskId.toHexString(), run] as const] : [])))
    const isPro = tier === "pro"
    return {
        tasks: tasks.map((task) => serializeSyncTask(task, task._id ? latestRun.get(task._id.toHexString()) : undefined, tier, isPlanLockedTask(task, tasks, isPro)))
    }
})
