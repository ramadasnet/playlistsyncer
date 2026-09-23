import {describe, expect, test} from "bun:test"
import {defaultProSyncIntervalMinutes, formatProSyncCadenceHeadline, formatProSyncIntervalEvery, proSyncIntervalMs} from "../shared/sync-cadence"

describe("PRO sync cadence copy", () => {
    test("formats interval labels for plan copy", () => {
        expect(formatProSyncIntervalEvery(720)).toBe("every 12 hours")
        expect(formatProSyncIntervalEvery(720, {capitalize: true})).toBe("Every 12 hours")
        expect(formatProSyncIntervalEvery(60)).toBe("every 1 hour")
        expect(formatProSyncIntervalEvery(90)).toBe("every 90 minutes")
        expect(formatProSyncIntervalEvery(1)).toBe("every 1 minute")
    })

    test("formats headlines when the interval divides a day", () => {
        expect(formatProSyncCadenceHeadline(720)).toBe("Twice a day")
        expect(formatProSyncCadenceHeadline(1440)).toBe("Once a day")
        expect(formatProSyncCadenceHeadline(360)).toBe("4 times a day")
        expect(formatProSyncCadenceHeadline(90)).toBe("16 times a day")
        expect(formatProSyncCadenceHeadline(100)).toBe("Every 100 minutes")
    })

    test("converts minutes to milliseconds for scheduling", () => {
        expect(defaultProSyncIntervalMinutes).toBe(720)
        expect(proSyncIntervalMs(defaultProSyncIntervalMinutes)).toBe(12 * 60 * 60 * 1000)
        expect(proSyncIntervalMs(90)).toBe(90 * 60 * 1000)
    })
})
