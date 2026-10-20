/** Display dates consistently while retaining the browser's local timezone. */
export function dateLabel(value?: string | null) {
    return value ? new Date(value).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}) : "Not recorded"
}

/** Present API errors without exposing server traces or provider response bodies. */
export function errorLabel(error: unknown) {
    const failure = error as {data?: {statusMessage?: string}; message?: string}
    return failure?.data?.statusMessage || failure?.message || "The request failed. Please retry."
}
