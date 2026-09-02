import {ObjectId} from "mongodb"

export function parseObjectId(value: string | undefined, label = "id"): ObjectId {
    if (!value || !ObjectId.isValid(value)) {
        throw createError({statusCode: 400, statusMessage: `Invalid ${label}`})
    }
    return new ObjectId(value)
}
