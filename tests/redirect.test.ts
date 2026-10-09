import {describe, expect, test} from "bun:test"
import {normalizeRedirect} from "../shared/redirect"

describe("post-login redirect", () => {
    test("keeps local paths with their query and hash", () => {
        expect(normalizeRedirect("/account")).toBe("/account")
        expect(normalizeRedirect("/sync/abc?tab=runs#latest")).toBe("/sync/abc?tab=runs#latest")
    })

    test("falls back for anything that would leave the origin", () => {
        for (const value of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/.//evil.example", "https://evil.example", "evil.example", "", undefined, ["/account"]]) {
            expect(normalizeRedirect(value)).toBe("/sync")
        }
    })

    test("uses the supplied fallback", () => {
        expect(normalizeRedirect("//evil.example", "/account")).toBe("/account")
    })
})
