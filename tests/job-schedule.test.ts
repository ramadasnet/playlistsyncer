import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {ObjectId} from "mongodb"
import {describe, expect, test} from "bun:test"
import {cronMatches, delayUntilNextMinute, parseCron} from "../server/jobs/cron"
import {createJobScheduler, defaultJobsPath, loadJobSchedule, type ScheduledJob} from "../server/jobs/schedule"

const sundayMidnight = new Date("2026-10-11T00:00:00.000Z")

function scheduled(name: ScheduledJob["name"], schedule = "* * * * *"): ScheduledJob {
    if (name === "sync-task") {
        return {name, schedule, cron: parseCron(schedule), parameters: {id: new ObjectId().toHexString()}}
    }
    return {name, schedule, cron: parseCron(schedule), parameters: {}}
}

async function withJobsFile(contents: string, assert: (path: string) => void) {
    const directory = await mkdtemp(join(tmpdir(), "playlistsyncer-jobs-"))
    const path = join(directory, "jobs.json")
    await writeFile(path, contents)
    try {
        assert(path)
    } finally {
        await rm(directory, {recursive: true, force: true})
    }
}

describe("cron", () => {
    test("matches lists, ranges, steps, names, and aliases in UTC", () => {
        expect(cronMatches(parseCron("0 * * * *"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("15 * * * *"), sundayMidnight)).toBe(false)
        expect(cronMatches(parseCron("*/15 * * * *"), new Date("2026-10-11T00:45:00.000Z"))).toBe(true)
        expect(cronMatches(parseCron("*/15 * * * *"), new Date("2026-10-11T00:10:00.000Z"))).toBe(false)
        expect(cronMatches(parseCron("0 9 1 JAN *"), new Date("2026-01-01T09:00:00.000Z"))).toBe(true)
        expect(cronMatches(parseCron("0 0 * * SUN"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("0 0 * * 7"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("@weekly"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("@hourly"), new Date("2026-10-11T04:00:10.000Z"))).toBe(true)
        expect(cronMatches(parseCron("0 9 * * MON-FRI"), new Date("2026-10-12T09:00:00.000Z"))).toBe(true)
        expect(cronMatches(parseCron("0 9 * * MON-FRI"), sundayMidnight)).toBe(false)
    })

    test("runs when either the day of month or the weekday matches", () => {
        expect(cronMatches(parseCron("0 0 11 * 1"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("0 0 12 * 0"), sundayMidnight)).toBe(true)
        expect(cronMatches(parseCron("0 0 12 * 1"), sundayMidnight)).toBe(false)
    })

    test("rejects an incomplete, unknown, or out-of-range expression", () => {
        expect(() => parseCron("0 * * *")).toThrow("5-field")
        expect(() => parseCron("@yearly")).toThrow("Unknown schedule alias")
        expect(() => parseCron("60 * * * *")).toThrow("minute")
        expect(() => parseCron("0 0 * * MONDAY")).toThrow("unknown name")
    })

    test("waits until the next UTC minute", () => {
        expect(delayUntilNextMinute(new Date("2026-10-11T21:49:30.000Z"))).toBe(30_000)
        expect(delayUntilNextMinute(new Date("2026-10-11T21:49:00.000Z"))).toBe(60_000)
        expect(delayUntilNextMinute(new Date("2026-10-11T21:49:59.250Z"))).toBe(750)
    })
})

describe("jobs.json", () => {
    test("loads the committed schedule", () => {
        const jobs = loadJobSchedule(defaultJobsPath)
        expect(jobs.map((job) => [job.name, job.schedule])).toEqual([
            ["sync-due", "0 * * * *"],
            ["weekly-sync-summary", "15 * * * *"]
        ])
        expect(jobs[0]?.parameters).toEqual({limit: 10})
        expect(jobs[1]?.parameters).toEqual({limit: 25})
    })

    test("returns no jobs when the file is missing", async () => {
        const directory = await mkdtemp(join(tmpdir(), "playlistsyncer-jobs-"))
        try {
            expect(loadJobSchedule(join(directory, "missing.json"))).toEqual([])
        } finally {
            await rm(directory, {recursive: true, force: true})
        }
    })

    test("refuses invalid JSON, unknown jobs, duplicate names, bad schedules, and bad parameters", async () => {
        await withJobsFile("{", (path) => expect(() => loadJobSchedule(path)).toThrow("Invalid jobs.json"))
        await withJobsFile(`[{"name":"other","schedule":"* * * * *"}]`, (path) => expect(() => loadJobSchedule(path)).toThrow("Invalid jobs.json"))
        await withJobsFile(`[{"name":"sync-due","schedule":"* * * * *"},{"name":"sync-due","schedule":"@daily"}]`, (path) => expect(() => loadJobSchedule(path)).toThrow("more than once"))
        await withJobsFile(`[{"name":"sync-due","schedule":"nope"}]`, (path) => expect(() => loadJobSchedule(path)).toThrow("sync-due schedule"))
        await withJobsFile(`[{"name":"sync-due","schedule":"@hourly","parameters":{"limit":0}}]`, (path) => expect(() => loadJobSchedule(path)).toThrow("sync-due parameters"))
        await withJobsFile(`[{"name":"sync-task","schedule":"@daily"}]`, (path) => expect(() => loadJobSchedule(path)).toThrow("sync-task parameters"))
        const id = new ObjectId().toHexString()
        await withJobsFile(`[{"name":"sync-task","schedule":"@daily","parameters":{"id":"${id}"}}]`, (path) => {
            expect(loadJobSchedule(path)[0]?.parameters).toEqual({id})
        })
    })
})

describe("job scheduler", () => {
    test("runs every matching job and skips the ones that do not match", async () => {
        const scheduler = createJobScheduler()
        const started: string[] = []
        await scheduler.run([scheduled("sync-due", "0 * * * *"), scheduled("weekly-sync-summary", "15 * * * *")], sundayMidnight, async (job) => {
            started.push(job.name)
        })
        expect(started).toEqual(["sync-due"])
    })

    test("skips a job that is still running", async () => {
        const scheduler = createJobScheduler()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let started = 0
        const first = scheduler.run([scheduled("sync-due")], sundayMidnight, async () => {
            started++
            await gate
        })
        await sleep(10)
        await scheduler.run([scheduled("sync-due")], sundayMidnight, async () => {
            started++
        })
        expect(started).toBe(1)
        release()
        await first
        await scheduler.run([scheduled("sync-due")], sundayMidnight, async () => {
            started++
        })
        expect(started).toBe(2)
    })

    test("logs a job failure and can run that job again", async () => {
        const scheduler = createJobScheduler()
        await scheduler.run([scheduled("sync-due")], sundayMidnight, async () => {
            throw new Error("boom")
        })
        let started = 0
        await scheduler.run([scheduled("sync-due")], sundayMidnight, async () => {
            started++
        })
        expect(started).toBe(1)
    })

    test("waits for a scheduled job during shutdown and then refuses new runs", async () => {
        const scheduler = createJobScheduler()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const running = scheduler.run([scheduled("weekly-sync-summary")], sundayMidnight, async () => {
            await gate
        })
        await sleep(10)
        let drained = false
        const done = scheduler.drain(2000).then(() => {
            drained = true
        })
        await sleep(20)
        expect(drained).toBe(false)
        release()
        await running
        await done
        expect(drained).toBe(true)
        const started: string[] = []
        await scheduler.run([scheduled("weekly-sync-summary")], sundayMidnight, async (job) => {
            started.push(job.name)
        })
        expect(started).toEqual([])
    })
})
