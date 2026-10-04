// Validate route identifiers before passing them to MongoDB.
import {createError} from "h3"
import {ObjectId} from "mongodb"

// Parse a string identifier or throw a client-facing validation error.
export function parseObjectId(value: string | undefined, label = "id"): ObjectId {
    if (!value || !ObjectId.isValid(value)) {
        throw createError({statusCode: 400, statusMessage: `Invalid ${label}`})
    }
    return new ObjectId(value)
}
