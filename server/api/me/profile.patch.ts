// Update the editable profile details of the authenticated account.
import {z} from "zod"
import {maxDisplayNameLength, normalizeDisplayName} from "../../../shared/display-name"
import {collections} from "../../data/collections"
import {requireUser, serializeUser} from "../../domain/auth/session"
import logger from "../../utils/logger"

const bodySchema = z.object({
    displayName: z
        .string()
        .transform(normalizeDisplayName)
        .pipe(z.string().min(1, "Display name is required").max(maxDisplayNameLength, `Display name must be ${maxDisplayNameLength} characters or fewer`))
})

// Validate the display name and return the refreshed session payload.
export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const parsed = bodySchema.safeParse(await readBody(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: parsed.error.issues[0]?.message || "Invalid display name"})
    }
    const now = new Date()
    const db = await collections()
    const updated = await db.users.findOneAndUpdate({_id: user._id!}, {$set: {displayName: parsed.data.displayName, updatedAt: now}}, {returnDocument: "after"})
    if (!updated) {
        throw createError({statusCode: 404, statusMessage: "Account not found"})
    }
    logger.info("Account.profile", `User ${user._id!.toHexString()}`, "Display name updated")
    return {user: serializeUser(updated)}
})
