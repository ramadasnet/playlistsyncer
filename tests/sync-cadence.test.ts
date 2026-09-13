import {describe, expect, test} from "bun:test"
import {formatProSyncCadenceHeadline, formatProSyncIntervalEvery, proSyncIntervalMs} from "../shared/sync-cadence"

describe("PRO sync cadence copy", () => {
    test("formats interval labels for plan copy", () => {
        expect(formatProSyncIntervalEvery(12)).toBe("every 12 hours")
        expect(formatProSyncIntervalEvery(12, {capitalize: true})).toBe("Every 12 hours")
        expect(formatProSyncIntervalEvery(1)).toBe("every 1 hour")
    })

    test("formats headlines when the interval divides a day", () => {
        expect(formatProSyncCadenceHeadline(12)).toBe("Twice a day")
        expect(formatProSyncCadenceHeadline(24)).toBe("Once a day")
        expect(formatProSyncCadenceHeadline(6)).toBe("4 times a day")
    })

    test("converts hours to milliseconds for scheduling", () => {
        expect(proSyncIntervalMs(12)).toBe(12 * 60 * 60 * 1000)
    })
})
