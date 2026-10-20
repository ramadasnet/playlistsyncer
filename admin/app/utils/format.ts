/** Present API errors without exposing server traces or provider response bodies. */
export function errorLabel(error: unknown) {
    const failure = error as {data?: {statusMessage?: string}; message?: string}
    return failure?.data?.statusMessage || failure?.message || "The request failed. Please retry."
}
