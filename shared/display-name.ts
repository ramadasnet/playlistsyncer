// Display name limits shared by the account API and the account page.

export const maxDisplayNameLength = 30

// Collapse surrounding and repeated whitespace before validating a display name.
export function normalizeDisplayName(value: string): string {
    return value.trim().replace(/\s+/g, " ")
}

// Fit provider-supplied names into the limit without leaving a broken surrogate pair.
export function truncateDisplayName(value: string): string {
    const normalized = normalizeDisplayName(value) || "Anonymous"
    if (normalized.length <= maxDisplayNameLength) {
        return normalized
    }
    return normalized
        .slice(0, maxDisplayNameLength)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trim()
}
