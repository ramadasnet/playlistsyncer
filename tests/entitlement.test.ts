import {describe, expect, test} from "bun:test"
import {complimentaryTrialEndsAt, planBadgeClass, planBadgeLabel} from "../app/utils/plan"
import {canStartCheckout, resolveEntitlement} from "../server/domain/billing/entitlement"

const freeUser = {email: "developer@example.com", tier: "free" as const}
const config = {developmentProUserEmails: ["developer@example.com"]}
const trialCutoff = new Date("2027-01-01T00:00:00.000Z")
const trialConfig = {developmentProUserEmails: [] as string[], proSubscriptionRequiredAt: trialCutoff}

describe("effective entitlement", () => {
    test("grants configured users PRO access during development", () => {
        expect(resolveEntitlement(freeUser, config, "development")).toEqual({
            tier: "pro",
            developmentOverride: true,
            trialAccess: false
        })
    })

    test("never grants configured users PRO access in production", () => {
        expect(resolveEntitlement(freeUser, config, "production")).toEqual({
            tier: "free",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("does not grant configured users PRO access without a confirmed email", () => {
        expect(resolveEntitlement({tier: "free"}, config, "development")).toEqual({
            tier: "free",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("does not grant configured users PRO access when the environment is unset", () => {
        expect(resolveEntitlement(freeUser, config, undefined)).toEqual({
            tier: "free",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("preserves paid PRO access in production", () => {
        expect(resolveEntitlement({...freeUser, tier: "pro"}, config, "production")).toEqual({
            tier: "pro",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("grants complimentary PRO before the subscription-required date", () => {
        expect(resolveEntitlement(freeUser, trialConfig, "production", new Date("2026-09-12T00:00:00.000Z"))).toEqual({
            tier: "pro",
            developmentOverride: false,
            trialAccess: true
        })
    })

    test("removes complimentary PRO once the subscription-required date has passed", () => {
        expect(resolveEntitlement(freeUser, trialConfig, "production", trialCutoff)).toEqual({
            tier: "free",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("does not treat paid PRO as trial access before the cutoff", () => {
        expect(resolveEntitlement({...freeUser, tier: "pro"}, trialConfig, "production", new Date("2026-09-12T00:00:00.000Z"))).toEqual({
            tier: "pro",
            developmentOverride: false,
            trialAccess: false
        })
    })

    test("lets trial accounts start checkout but not paid or development overrides", () => {
        expect(canStartCheckout({tier: "free", developmentOverride: false, trialAccess: false})).toBe(true)
        expect(canStartCheckout({tier: "pro", developmentOverride: false, trialAccess: true})).toBe(true)
        expect(canStartCheckout({tier: "pro", developmentOverride: false, trialAccess: false})).toBe(false)
        expect(canStartCheckout({tier: "pro", developmentOverride: true, trialAccess: false})).toBe(false)
    })

    test("labels promotional PRO access in plan badges", () => {
        expect(planBadgeClass({tier: "pro", developmentProOverride: false, trialAccess: true})).toBe("plan-trial")
        expect(planBadgeLabel({tier: "pro", developmentProOverride: false, trialAccess: true})).toBe("PRO / PROMOTION")
        expect(planBadgeLabel({tier: "pro", developmentProOverride: false, trialAccess: true}, true)).toBe("PRO / PROMO")
        expect(complimentaryTrialEndsAt("2027-01-01T00:00:00.000Z", new Date("2026-09-12T00:00:00.000Z"))?.toISOString()).toBe("2027-01-01T00:00:00.000Z")
        expect(complimentaryTrialEndsAt("2027-01-01T00:00:00.000Z", new Date("2027-01-01T00:00:00.000Z"))).toBeUndefined()
    })
})
