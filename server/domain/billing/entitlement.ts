// Resolve paid, trial, and development access for a user.
import type {UserDocument} from "~~/shared/types/domain"
import {isComplimentaryTrialActive} from "../../../shared/trial"
import {getServerConfig, type ServerConfig} from "../../utils/config"

type EntitlementUser = Pick<UserDocument, "email" | "tier">
type EntitlementConfig = Pick<ServerConfig, "developmentProUserEmails" | "proSubscriptionRequiredAt">

export interface EffectiveEntitlement {
    tier: UserDocument["tier"]
    developmentOverride: boolean
    trialAccess: boolean
}

// Calculate the effective tier, including configured development and trial access.
export function resolveEntitlement(user: EntitlementUser, config: EntitlementConfig = getServerConfig(), nodeEnv: string | undefined = process.env.NODE_ENV, now: Date = new Date()): EffectiveEntitlement {
    const developmentOverride = nodeEnv === "development" && Boolean(user.email && config.developmentProUserEmails.includes(user.email.trim().toLowerCase()))

    if (developmentOverride) {
        return {tier: "pro", developmentOverride: true, trialAccess: false}
    }
    if (user.tier === "pro") {
        return {tier: "pro", developmentOverride: false, trialAccess: false}
    }
    if (isComplimentaryTrialActive(config.proSubscriptionRequiredAt, now)) {
        return {tier: "pro", developmentOverride: false, trialAccess: true}
    }

    return {tier: "free", developmentOverride: false, trialAccess: false}
}

// Determine whether the account may begin a paid checkout flow.
export function canStartCheckout(entitlement: EffectiveEntitlement): boolean {
    return entitlement.tier === "free" || entitlement.trialAccess
}
