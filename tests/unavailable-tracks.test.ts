import {describe, expect, test} from "bun:test"
import {isUnavailableSyncTrack, unmatchedCategoryCounts} from "../shared/unavailable-tracks"

describe("unavailable YouTube videos", () => {
    test("recognizes deleted and private video placeholders", () => {
        expect(isUnavailableSyncTrack({title: "Deleted video"})).toBe(true)
        expect(isUnavailableSyncTrack({title: "Private video"})).toBe(true)
        expect(isUnavailableSyncTrack({title: "  [Deleted video]  "})).toBe(true)
        expect(isUnavailableSyncTrack({title: "Midnight Radio"})).toBe(false)
        expect(isUnavailableSyncTrack({title: "Private video session"})).toBe(false)
    })

    test("keeps unlabeled skipped tracks in the unmatched count", () => {
        expect(unmatchedCategoryCounts(5, [{title: "Deleted video"}, {title: "Private video"}, {title: "Missing Song"}])).toEqual({unmatched: 3, unavailable: 2})
        expect(unmatchedCategoryCounts(4, [])).toEqual({unmatched: 4, unavailable: 0})
    })
})
