import {z} from "zod"
import {collections} from "../../data/collections"
import {requireUser, serializeUser} from "../../domain/auth/session"
import {resolveEntitlement} from "../../domain/billing/entitlement"
import {evaluateWeeklySyncSummaryPreference} from "../../domain/mail/weekly-sync-summary"
import logger from "../../utils/logger"

const bodySchema = z.object({
    weeklySyncSummaryEnabled: z.boolean()
})

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    const body = bodySchema.parse(await readBody(event))
    const evaluation = evaluateWeeklySyncSummaryPreference({
        tier: resolveEntitlement(user).tier,
        email: user.email,
        enabled: body.weeklySyncSummaryEnabled
    })
    if (!evaluation.ok) {
        throw createError({statusCode: evaluation.statusCode, statusMessage: evaluation.statusMessage})
    }
    const now = new Date()
    const db = await collections()
    const updated = await db.users.findOneAndUpdate(
        {_id: user._id!},
        {$set: {weeklySyncSummaryEnabled: body.weeklySyncSummaryEnabled, updatedAt: now}},
        {returnDocument: "after"}
    )
    if (!updated) {
        throw createError({statusCode: 404, statusMessage: "Account not found"})
    }
    logger.info(
        "Account.preferences",
        `User ${user._id!.toHexString()}`,
        `Weekly summary ${body.weeklySyncSummaryEnabled}`
    )
    return {user: serializeUser(updated)}
})
