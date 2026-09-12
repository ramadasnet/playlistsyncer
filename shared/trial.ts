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

export function isComplimentaryTrialActive(
    requiredAt: string | Date | undefined | null,
    now: Date = new Date()
): boolean {
    const date = parseSubscriptionRequiredAt(requiredAt)
    return Boolean(date && now < date)
}
