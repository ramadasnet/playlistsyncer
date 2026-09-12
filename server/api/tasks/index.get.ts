import {collections} from "../../data/collections"
import {requireUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {applyTaskEntitlement, isPlanLockedTask} from "../../domain/billing/task-entitlement"
import {canViewRunHistory, serializeSyncTask} from "../../domain/sync/history-visibility"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    await applyTaskEntitlement(user)
    const db = await collections()
    const tasks = await db.syncTasks.find({userId: user._id!}).sort({createdAt: -1}).toArray()
    const tier = resolveEntitlement(user).tier
    const taskIds = canViewRunHistory(tier) ? tasks.flatMap((task) => (task._id ? [task._id] : [])) : []
    const runs = taskIds.length
        ? await db.syncRuns
              .find(
                  {taskId: {$in: taskIds}},
                  {
                      projection: {
                          taskId: 1,
                          status: 1,
                          additions: 1,
                          removals: 1,
                          conflicts: 1,
                          skipped: 1,
                          startedAt: 1
                      }
                  }
              )
              .sort({startedAt: 1})
              .toArray()
        : []
    const latestRun = new Map(runs.map((run) => [run.taskId.toHexString(), run]))
    const isPro = tier === "pro"
    return {
        tasks: tasks.map((task) =>
            serializeSyncTask(
                task,
                task._id ? latestRun.get(task._id.toHexString()) : undefined,
                tier,
                isPlanLockedTask(task, tasks, isPro)
            )
        )
    }
})
