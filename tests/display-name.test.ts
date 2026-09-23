import {describe, expect, test} from "bun:test"
import {maxDisplayNameLength, normalizeDisplayName, truncateDisplayName} from "../shared/display-name"
import {newUserFromOAuthProfile} from "../server/domain/auth/oauth"

const now = new Date("2026-09-22T12:00:00.000Z")

describe("display name limits", () => {
    test("limits display names to 30 characters", () => {
        expect(maxDisplayNameLength).toBe(30)
    })

    test("collapses surrounding and repeated whitespace", () => {
        expect(normalizeDisplayName("  Alex   Listener \n")).toBe("Alex Listener")
    })

    test("keeps names within the limit unchanged", () => {
        expect(truncateDisplayName("Alex")).toBe("Alex")
        expect(truncateDisplayName("a".repeat(30))).toBe("a".repeat(30))
    })

    test("truncates long names to the limit", () => {
        expect(truncateDisplayName("a".repeat(45))).toBe("a".repeat(30))
    })

    test("does not leave a broken surrogate pair when truncating", () => {
        const truncated = truncateDisplayName(`${"a".repeat(29)}🎵🎵`)

        expect(truncated).toBe("a".repeat(29))
        expect(truncated.length).toBeLessThanOrEqual(maxDisplayNameLength)
    })

    test("truncates long provider names for new users", () => {
        const user = newUserFromOAuthProfile({id: "spotify-long", emailVerified: false, displayName: "A Very Long Spotify Display Name Indeed"}, now)

        expect(user.displayName).toBe("A Very Long Spotify Display Na")
    })

    test("never stores a blank provider-supplied display name", () => {
        expect(truncateDisplayName(" \n ")).toBe("Anonymous")
    })
})
