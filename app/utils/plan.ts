import type {SessionUser} from "~/types/api"
import {isComplimentaryTrialActive} from "~~/shared/trial"

// Select the visual badge class for the user's effective plan.
export function planBadgeClass(user: Pick<SessionUser, "tier" | "developmentProOverride" | "trialAccess">): string {
    if (user.developmentProOverride) {
        return "plan-development"
    }
    if (user.trialAccess) {
        return "plan-trial"
    }
    return `plan-${user.tier}`
}

// Return the user-facing label for the effective plan.
export function planBadgeLabel(user: Pick<SessionUser, "tier" | "developmentProOverride" | "trialAccess">, compact = false): string {
    if (user.developmentProOverride) {
        return compact ? "PRO / DEV" : "PRO / DEVELOPMENT"
    }
    if (user.trialAccess) {
        return "PRO / TRIAL"
    }
    return user.tier
}

// Resolve the date on which complimentary access ends.
export function complimentaryTrialEndsAt(requiredAt: string | Date | undefined | null, now: Date = new Date()): Date | undefined {
    if (!isComplimentaryTrialActive(requiredAt, now)) {
        return undefined
    }
    return requiredAt instanceof Date ? requiredAt : new Date(String(requiredAt))
}

// Format a trial date for display in the account interface.
export function formatTrialDate(value: Date | undefined): string {
    return value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(value) : ""
}
