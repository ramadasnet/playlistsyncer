import {describe, expect, test} from "bun:test"

// The middleware module relies on Nuxt auto-imports; stub the one used at module scope.
;(globalThis as Record<string, unknown>).defineEventHandler = (handler: unknown) => handler

const {contentSecurityPolicy} = await import("../server/middleware/security")

describe("content security policy", () => {
    test("allows the support chat iframe instead of falling back to default-src", () => {
        const frameSrc = contentSecurityPolicy()
            .split("; ")
            .find((directive) => directive.startsWith("frame-src "))

        expect(frameSrc).toContain("https://api.chatlab.com")
    })

    test("still forbids framing the app itself", () => {
        expect(contentSecurityPolicy()).toContain("frame-ancestors 'none'")
    })
})
