import {describe, expect, test} from "bun:test"
import {formatDuration} from "../shared/format-duration"

describe("format duration", () => {
    test("renders minutes and seconds under an hour", () => {
        expect(formatDuration(75_000)).toBe("1:15")
        expect(formatDuration(9_000)).toBe("0:09")
    })

    test("includes hours once the length reaches an hour", () => {
        expect(formatDuration(4_530_000)).toBe("1:15:30")
        expect(formatDuration(3_600_000)).toBe("1:00:00")
    })

    test("returns nothing when the length is missing", () => {
        expect(formatDuration()).toBe("")
        expect(formatDuration(0)).toBe("")
    })
})
