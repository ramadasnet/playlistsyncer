// Adapt MongoDB driver calls to Firestore with MongoDB compatibility without changing local MongoDB.

// True when the URI points at a Firestore MongoDB-compatible endpoint.
export function isFirestoreMongoUri(uri: string): boolean {
    try {
        return new URL(uri).hostname.endsWith(".firestore.goog")
    } catch {
        return false
    }
}

// Database ID embedded in a Firestore URI, when the URI has one.
export function firestoreUriDatabase(uri: string): string | undefined {
    if (!isFirestoreMongoUri(uri)) return undefined
    try {
        const name = decodeURIComponent(new URL(uri).pathname.replace(/^\//, ""))
        return name || undefined
    } catch {
        return undefined
    }
}

// Firestore rejects retryable writes and requires TLS. loadBalanced stays in the URI because the driver refuses it here.
export function firestoreMongoOptions(uri: string): {retryWrites: false; tls: true} | Record<string, never> {
    if (!isFirestoreMongoUri(uri)) return {}
    return {retryWrites: false, tls: true}
}

// Recognize a unique-index conflict from MongoDB and from a driver error that uses the DuplicateKey name.
export function isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const candidate = error as {code?: unknown; codeName?: unknown}
    return candidate.code === 11000 || candidate.codeName === "DuplicateKey"
}

// Field named by a unique-index conflict, when the driver includes it.
export function duplicateKeyField(error: unknown): string | undefined {
    if (!isDuplicateKeyError(error) || !error || typeof error !== "object") return undefined
    const keyPattern = (error as {keyPattern?: Record<string, unknown>}).keyPattern
    const field = keyPattern ? Object.keys(keyPattern)[0] : undefined
    if (field) return field
    const message = (error as {message?: unknown}).message
    if (typeof message === "string" && message.includes("playlistWriteKeys")) return "playlistWriteKeys"
    return undefined
}
