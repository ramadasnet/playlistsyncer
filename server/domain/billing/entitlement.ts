import type {UserDocument} from "~~/shared/types/domain"
import {getServerConfig, type ServerConfig} from "../../utils/config"

type EntitlementUser = Pick<UserDocument, "email" | "tier">
type EntitlementConfig = Pick<ServerConfig, "developmentProUserEmails">

export interface EffectiveEntitlement {
    tier: UserDocument["tier"]
    developmentOverride: boolean
}

export function resolveEntitlement(
    user: EntitlementUser,
    config: EntitlementConfig = getServerConfig(),
    nodeEnv: string | undefined = process.env.NODE_ENV
): EffectiveEntitlement {
    const developmentOverride =
        nodeEnv === "development" && config.developmentProUserEmails.includes(user.email.trim().toLowerCase())

    return {
        tier: developmentOverride ? "pro" : user.tier,
        developmentOverride
    }
}
