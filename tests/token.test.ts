import {describe, expect, test} from "bun:test"
import {accessTokenNeedsRefresh, tokenRefreshSkewMs} from "../server/domain/providers/token"

describe("provider access token refresh window", () => {
    test("refreshes tokens that expire within the session buffer", () => {
        const now = Date.parse("2026-09-15T21:00:00.000Z")

        expect(accessTokenNeedsRefresh(undefined, now)).toBe(false)
        expect(accessTokenNeedsRefresh(new Date(now + tokenRefreshSkewMs + 1), now)).toBe(false)
        expect(accessTokenNeedsRefresh(new Date(now + tokenRefreshSkewMs), now)).toBe(true)
        expect(accessTokenNeedsRefresh(new Date(now + 60_000), now)).toBe(true)
        expect(accessTokenNeedsRefresh(new Date(now - 1_000), now)).toBe(true)
    })
})
