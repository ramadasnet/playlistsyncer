// Refuse new requests while the website drains its in-flight sync runs.
import {isShuttingDown} from "../utils/shutdown"

export default defineEventHandler(() => {
    if (isShuttingDown()) {
        throw createError({statusCode: 503, statusMessage: "Server is shutting down"})
    }
})
