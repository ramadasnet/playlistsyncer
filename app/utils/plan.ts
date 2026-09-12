import type {SessionUser} from "~/types/api"
import {isComplimentaryTrialActive} from "~~/shared/trial"

export function planBadgeClass(user: Pick<SessionUser, "tier" | "developmentProOverride" | "trialAccess">): string {
    if (user.developmentProOverride) {
        return "plan-development"
    }
    if (user.trialAccess) {
        return "plan-trial"
    }
    return `plan-${user.tier}`
}

export function planBadgeLabel(
    user: Pick<SessionUser, "tier" | "developmentProOverride" | "trialAccess">,
    compact = false
): string {
    if (user.developmentProOverride) {
        return compact ? "PRO / DEV" : "PRO / DEVELOPMENT"
    }
    if (user.trialAccess) {
        return "PRO / TRIAL"
    }
    return user.tier
}

export function complimentaryTrialEndsAt(
    requiredAt: string | Date | undefined | null,
    now: Date = new Date()
): Date | undefined {
    if (!isComplimentaryTrialActive(requiredAt, now)) {
        return undefined
    }
    return requiredAt instanceof Date ? requiredAt : new Date(String(requiredAt))
}

export function formatTrialDate(value: Date | undefined): string {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(value) : ""
}
