import {describe, expect, test} from "bun:test"
import {hasPaidEntitlement} from "../server/domain/billing/creem"

describe("Creem billing entitlements", () => {
    test("keeps access only for paid subscription states", () => {
        expect(hasPaidEntitlement("active")).toBe(true)
        expect(hasPaidEntitlement("trialing")).toBe(true)
        expect(hasPaidEntitlement("scheduled_cancel")).toBe(true)
        expect(hasPaidEntitlement("canceled")).toBe(false)
        expect(hasPaidEntitlement("expired")).toBe(false)
        expect(hasPaidEntitlement("past_due")).toBe(false)
        expect(hasPaidEntitlement("paused")).toBe(false)
        expect(hasPaidEntitlement("unpaid")).toBe(false)
    })
})
