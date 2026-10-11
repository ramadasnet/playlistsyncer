// Load jobs.json and run its jobs on a UTC cron schedule, without an external HTTP caller.
import {existsSync, readFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {clearTimeout, setTimeout} from "node:timers"
import {setTimeout as sleep} from "node:timers/promises"
import {fileURLToPath} from "node:url"
import {ObjectId} from "mongodb"
import {z} from "zod"
import logger from "../utils/logger"
import {isShuttingDown} from "../utils/shutdown"
import {cronMatches, delayUntilNextMinute, parseCron, type ParsedCron} from "./cron"
import {runSyncDue} from "./routes/sync-due"
import {runSyncTask} from "./routes/sync-task"
import {runWeeklySyncSummary} from "./routes/weekly-sync-summary"

export const defaultJobsPath = join(dirname(fileURLToPath(import.meta.url)), "../../jobs.json")

const limitParameter = z.number().int().min(1).max(100).optional()
const parameterSchemas = {
    "sync-due": z.object({limit: limitParameter}).strict(),
    "sync-task": z.object({id: z.string().refine((value) => ObjectId.isValid(value), {message: "must be a task id"})}).strict(),
    "weekly-sync-summary": z.object({limit: limitParameter}).strict()
}

const scheduledJobSchema = z
    .object({
        name: z.enum(["sync-due", "sync-task", "weekly-sync-summary"]),
        schedule: z.string().trim().min(1),
        parameters: z.record(z.string(), z.unknown()).optional()
    })
    .strict()

export type ScheduledJob = {
    [Name in keyof typeof parameterSchemas]: {
        name: Name
        schedule: string
        cron: ParsedCron
        parameters: z.infer<(typeof parameterSchemas)[Name]>
    }
}[keyof typeof parameterSchemas]

export type JobRunner = (job: ScheduledJob) => Promise<unknown>

// Read and validate the schedule file. A missing file means jobs run only from HTTP.
export function loadJobSchedule(path = defaultJobsPath): ScheduledJob[] {
    if (!existsSync(path)) {
        logger.info("Jobs.schedule", `No schedule file at ${path}; jobs run only when triggered over HTTP`)
        return []
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        throw new Error(`Invalid jobs.json: ${message}`)
    }
    const file = z.array(scheduledJobSchema).safeParse(parsed)
    if (!file.success) {
        throw new Error(`Invalid jobs.json: ${formatIssues(file.error)}`)
    }
    const names = new Set<string>()
    return file.data.map((entry) => {
        if (names.has(entry.name)) {
            throw new Error(`Invalid jobs.json: ${entry.name} is listed more than once`)
        }
        names.add(entry.name)
        const parameters = parameterSchemas[entry.name].safeParse(entry.parameters ?? {})
        if (!parameters.success) {
            throw new Error(`Invalid jobs.json: ${entry.name} parameters: ${formatIssues(parameters.error)}`)
        }
        let cron: ParsedCron
        try {
            cron = parseCron(entry.schedule)
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid schedule"
            throw new Error(`Invalid jobs.json: ${entry.name} schedule: ${message}`)
        }
        return {name: entry.name, schedule: entry.schedule, cron, parameters: parameters.data} as ScheduledJob
    })
}

// Run one configured job with the parameters from jobs.json.
export async function runConfiguredJob(job: ScheduledJob): Promise<unknown> {
    switch (job.name) {
        case "sync-due":
            return runSyncDue(job.parameters.limit)
        case "sync-task":
            return runSyncTask(job.parameters.id)
        case "weekly-sync-summary":
            return runWeeklySyncSummary(job.parameters.limit)
    }
}

/**
 * Owns one schedule timer and the jobs it has started.
 * A job that is still running is skipped on the next matching tick instead of being started twice.
 */
export function createJobScheduler() {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const running = new Set<string>()
    const inflight = new Set<Promise<void>>()

    // Start every job whose cron matches this minute. Matching jobs from one tick run together.
    async function run(entries: ScheduledJob[], now = new Date(), execute: JobRunner = runConfiguredJob): Promise<void> {
        const started: Promise<void>[] = []
        for (const entry of entries) {
            if (stopped || isShuttingDown()) break
            if (!cronMatches(entry.cron, now)) continue
            const work = launch(entry, execute)
            if (work) started.push(work)
        }
        await Promise.all(started)
    }

    function launch(entry: ScheduledJob, execute: JobRunner): Promise<void> | undefined {
        if (stopped || isShuttingDown()) return undefined
        if (running.has(entry.name)) {
            logger.warn("Jobs.schedule", `${entry.name} is still running; skipping this tick`)
            return undefined
        }
        let finished!: () => void
        const work = new Promise<void>((resolve) => {
            finished = resolve
        })
        running.add(entry.name)
        inflight.add(work)
        void (async () => {
            try {
                logger.info("Jobs.schedule", `Running ${entry.name}`)
                await execute(entry)
                logger.info("Jobs.schedule", `Finished ${entry.name}`)
            } catch (error) {
                logger.error("Jobs.schedule", entry.name, error)
            } finally {
                running.delete(entry.name)
                inflight.delete(work)
                finished()
            }
        })()
        return work
    }

    // Check the schedule at each UTC minute boundary until stop.
    function start(entries: ScheduledJob[]): void {
        stop()
        stopped = false
        if (!entries.length) return
        for (const entry of entries) {
            logger.info("Jobs.schedule", `${entry.name} scheduled at ${entry.schedule}`)
        }
        const arm = () => {
            if (stopped) return
            timer = setTimeout(() => {
                void run(entries).catch((error) => logger.error("Jobs.schedule", error))
                arm()
            }, delayUntilNextMinute())
        }
        arm()
    }

    function stop(): void {
        stopped = true
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
    }

    // Stop new ticks and wait for jobs started by this scheduler.
    async function drain(timeoutMs: number): Promise<void> {
        stop()
        const budgetMs = Math.max(0, timeoutMs)
        const deadline = Date.now() + budgetMs
        if (inflight.size) {
            logger.info("Jobs.schedule", `Waiting up to ${budgetMs}ms for ${inflight.size} scheduled job(s)`)
        }
        while (inflight.size && Date.now() < deadline) {
            await Promise.race([Promise.allSettled([...inflight]), sleep(deadline - Date.now(), undefined, {ref: false})])
        }
        if (inflight.size) {
            logger.warn("Jobs.schedule", `${inflight.size} scheduled job(s) still running at the shutdown deadline`)
        }
    }

    return {run, start, stop, drain}
}

function formatIssues(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join(".") || "jobs"}: ${issue.message}`).join("; ")
}
