import {describe, expect, test} from "bun:test"
import {resolveEntitlement} from "../server/domain/billing/entitlement"

const freeUser = {email: "developer@example.com", tier: "free" as const}
const config = {developmentProUserEmails: ["developer@example.com"]}

describe("effective entitlement", () => {
    test("grants configured users PRO access during development", () => {
        expect(resolveEntitlement(freeUser, config, "development")).toEqual({
            tier: "pro",
            developmentOverride: true
        })
    })

    test("never grants configured users PRO access in production", () => {
        expect(resolveEntitlement(freeUser, config, "production")).toEqual({
            tier: "free",
            developmentOverride: false
        })
    })

    test("does not grant configured users PRO access without a confirmed email", () => {
        expect(resolveEntitlement({tier: "free"}, config, "development")).toEqual({
            tier: "free",
            developmentOverride: false
        })
    })

    test("does not grant configured users PRO access when the environment is unset", () => {
        expect(resolveEntitlement(freeUser, config, undefined)).toEqual({
            tier: "free",
            developmentOverride: false
        })
    })

    test("preserves paid PRO access in production", () => {
        expect(resolveEntitlement({...freeUser, tier: "pro"}, config, "production")).toEqual({
            tier: "pro",
            developmentOverride: false
        })
    })
})
