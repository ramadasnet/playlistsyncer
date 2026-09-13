// Parse the subscription cutoff while rejecting invalid dates.
export function parseSubscriptionRequiredAt(value: string | Date | undefined | null): Date | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value
    }
    if (typeof value !== "string" || !value.trim()) {
        return undefined
    }
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

// Check whether the complimentary access period is still active.
export function isComplimentaryTrialActive(requiredAt: string | Date | undefined | null, now: Date = new Date()): boolean {
    const date = parseSubscriptionRequiredAt(requiredAt)
    return Boolean(date && now < date)
}

// Resolve the trial cutoff exposed to the public application.
export function resolvePublicTrialCutoff(environment: Record<string, string | undefined>, baked = ""): string {
    return environment.PRO_SUBSCRIPTION_REQUIRED_AT?.trim() || environment.NUXT_PUBLIC_PRO_SUBSCRIPTION_REQUIRED_AT?.trim() || baked.trim()
}
