// Validate addresses and manage expiring email-confirmation transactions.
import {randomBytes} from "node:crypto"
import {createError} from "h3"
import type {WithId} from "mongodb"
import {z} from "zod"
import type {UserDocument} from "~~/shared/types/domain"
import {collections} from "../../data/collections"
import {getServerConfig, requireConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {isDuplicateKeyError} from "../../utils/mongodb"
import {sendMail, type OutboundEmail} from "../mail/send"
import {hashOpaqueToken} from "./session"

export const emailConfirmationTtlMs = 24 * 60 * 60 * 1000
export const emailConfirmationResendCooldownMs = 60 * 1000

const emailSchema = z.email()

export interface EmailConfirmationRequestResult {
    tempEmail: string
    sent: boolean
    devConfirmationUrl?: string
}

export interface PreparedEmailConfirmation {
    email: string
    token: string
    tokenHash: string
    expiresAt: Date
    confirmUrl: string
    message: OutboundEmail
}

// Normalize and validate an account email address.
export function normalizeAccountEmail(value: string): string {
    const parsed = emailSchema.safeParse(value.trim())
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: "Enter a valid email address"})
    }
    return parsed.data.toLowerCase()
}

// Build the plain-text and HTML confirmation message.
export function buildConfirmationEmail(input: {to: string; confirmUrl: string; appName?: string}): OutboundEmail {
    const appName = input.appName || "PlaylistSyncer"
    const subject = `Confirm your ${appName} email address`
    const text = [`Confirm this email address for your ${appName} account:`, "", input.confirmUrl, "", "This link expires in 24 hours. If you did not request this, you can ignore the message."].join("\n")
    const html = [
        `<p>Confirm this email address for your ${appName} account.</p>`,
        `<p><a href="${input.confirmUrl}">Confirm email address</a></p>`,
        "<p>This link expires in 24 hours. If you did not request this, you can ignore the message.</p>"
    ].join("")
    return {to: input.to, subject, text, html}
}

// Create the token, expiry, URL, and message used for confirmation.
export function prepareEmailConfirmation(input: {email: string; appUrl: string; secret: string; now?: Date; token?: string; appName?: string}): PreparedEmailConfirmation {
    const now = input.now ?? new Date()
    const token = input.token ?? randomBytes(32).toString("base64url")
    const confirmUrl = `${input.appUrl}/confirm-email?token=${token}`
    return {
        email: input.email,
        token,
        tokenHash: hashOpaqueToken(token, input.secret),
        expiresAt: new Date(now.getTime() + emailConfirmationTtlMs),
        confirmUrl,
        message: buildConfirmationEmail({to: input.email, confirmUrl, appName: input.appName})
    }
}

// Reject the current confirmed address and rate-limit resends of the same pending address.
export function evaluatePendingEmailRequest(user: Pick<UserDocument, "email" | "tempEmail" | "emailConfirmationSentAt">, email: string, now: Date): {ok: true} | {ok: false; statusCode: number; statusMessage: string} {
    if (user.email === email) {
        return {ok: false, statusCode: 409, statusMessage: "This is already your confirmed email address"}
    }
    if (user.tempEmail === email && user.emailConfirmationSentAt && now.getTime() - user.emailConfirmationSentAt.getTime() < emailConfirmationResendCooldownMs) {
        return {ok: false, statusCode: 429, statusMessage: "Wait a moment before requesting another confirmation email"}
    }
    return {ok: true}
}

// Validate the stored confirmation token state at consumption time.
export function evaluateEmailConfirmationToken(user: Pick<UserDocument, "tempEmail" | "emailVerificationExpiresAt"> | null, now: Date): {ok: true; email: string} | {ok: false; statusCode: number; statusMessage: string} {
    const invalid = {
        ok: false as const,
        statusCode: 400,
        statusMessage: "This confirmation link is invalid or has expired"
    }
    if (!user?.tempEmail || !user.emailVerificationExpiresAt) {
        return invalid
    }
    if (user.emailVerificationExpiresAt.getTime() <= now.getTime()) {
        return invalid
    }
    return {ok: true, email: user.tempEmail}
}

const pendingEmailUnset = {
    tempEmail: "" as const,
    emailVerificationTokenHash: "" as const,
    emailVerificationExpiresAt: "" as const,
    emailConfirmationSentAt: "" as const
}

// Produce the MongoDB update that stores a pending confirmation.
export function pendingEmailUpdate(prepared: PreparedEmailConfirmation, now: Date) {
    return {
        $set: {
            tempEmail: prepared.email,
            emailVerificationTokenHash: prepared.tokenHash,
            emailVerificationExpiresAt: prepared.expiresAt,
            emailConfirmationSentAt: now,
            updatedAt: now
        }
    }
}

// Produce the MongoDB update that promotes a temporary email to confirmed.
export function confirmedEmailUpdate(email: string, now: Date) {
    return {
        $set: {email, updatedAt: now},
        $unset: pendingEmailUnset
    }
}

// Produce the MongoDB update that discards a pending confirmation without changing email.
export function canceledPendingEmailUpdate(now: Date) {
    return {
        $set: {updatedAt: now},
        $unset: pendingEmailUnset
    }
}

// Require a pending address before canceling confirmation.
export function evaluateCancelPendingEmail(user: Pick<UserDocument, "tempEmail">): {ok: true} | {ok: false; statusCode: number; statusMessage: string} {
    if (!user.tempEmail) {
        return {ok: false, statusCode: 409, statusMessage: "There is no pending email confirmation to cancel"}
    }
    return {ok: true}
}

// Reserve an email, send its confirmation message, and expose dev-only links.
export async function requestEmailConfirmation(
    user: UserDocument,
    email: string,
    options: {
        now?: Date
        appUrl?: string
        secret?: string
        send?: (message: OutboundEmail) => Promise<boolean>
        nodeEnv?: string
    } = {}
): Promise<EmailConfirmationRequestResult> {
    const normalized = normalizeAccountEmail(email)
    const now = options.now ?? new Date()
    const evaluation = evaluatePendingEmailRequest(user, normalized, now)
    if (!evaluation.ok) {
        throw createError({statusCode: evaluation.statusCode, statusMessage: evaluation.statusMessage})
    }

    const db = await collections()
    const claimed = await db.users.findOne({
        _id: {$ne: user._id},
        $or: [{email: normalized}, {tempEmail: normalized}]
    })
    if (claimed) {
        logger.warn("Email.request", `User ${user._id!.toHexString()}`, "Email is already registered")
        throw createError({statusCode: 409, statusMessage: "This email is already registered"})
    }

    const prepared = prepareEmailConfirmation({
        email: normalized,
        appUrl: options.appUrl ?? getServerConfig().appUrl,
        secret: options.secret ?? requireConfig("sessionSecret"),
        now
    })

    try {
        await db.users.updateOne({_id: user._id}, pendingEmailUpdate(prepared, now))
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            throw createError({statusCode: 409, statusMessage: "This email is already registered"})
        }
        throw error
    }

    const send = options.send ?? sendMail
    let sent = false
    try {
        sent = await send(prepared.message)
    } catch (error) {
        logger.error("Email.request", `User ${user._id!.toHexString()}`, error, "Confirmation email failed")
        throw createError({statusCode: 502, statusMessage: "The confirmation email could not be sent"})
    }
    logger.info("Email.request", `User ${user._id!.toHexString()}`, sent ? "Confirmation email sent" : "Confirmation email skipped")

    const allowDevUrl = (options.nodeEnv ?? process.env.NODE_ENV) !== "production" && !sent
    return {
        tempEmail: normalized,
        sent,
        ...(allowDevUrl ? {devConfirmationUrl: prepared.confirmUrl} : {})
    }
}

// Consume a valid token and atomically complete email confirmation.
export async function confirmEmail(token: string, options: {now?: Date; secret?: string} = {}): Promise<UserDocument> {
    const now = options.now ?? new Date()
    const tokenHash = hashOpaqueToken(token, options.secret ?? requireConfig("sessionSecret"))
    const db = await collections()
    const user = await db.users.findOne({emailVerificationTokenHash: tokenHash})
    const evaluation = evaluateEmailConfirmationToken(user, now)
    if (!user || !evaluation.ok) {
        logger.warn("Email.confirm", "Confirmation token is invalid or expired")
        throw createError({
            statusCode: evaluation.ok ? 400 : evaluation.statusCode,
            statusMessage: evaluation.ok ? "This confirmation link is invalid or has expired" : evaluation.statusMessage
        })
    }

    const taken = await db.users.findOne({email: evaluation.email, _id: {$ne: user._id}})
    if (taken) {
        logger.warn("Email.confirm", `User ${user._id!.toHexString()}`, "Email is already registered")
        throw createError({statusCode: 409, statusMessage: "This email is already registered"})
    }

    try {
        await db.users.updateOne({_id: user._id}, confirmedEmailUpdate(evaluation.email, now))
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            throw createError({statusCode: 409, statusMessage: "This email is already registered"})
        }
        throw error
    }

    logger.info("Email.confirm", `User ${user._id!.toHexString()}`, "Email confirmed")
    return {...user, email: evaluation.email, tempEmail: undefined}
}

// Drop a pending confirmation and leave any confirmed email in place.
export async function cancelPendingEmail(user: UserDocument, options: {now?: Date} = {}): Promise<WithId<UserDocument>> {
    const evaluation = evaluateCancelPendingEmail(user)
    if (!evaluation.ok) {
        throw createError({statusCode: evaluation.statusCode, statusMessage: evaluation.statusMessage})
    }

    const now = options.now ?? new Date()
    const db = await collections()
    const updated = await db.users.findOneAndUpdate({_id: user._id, tempEmail: {$exists: true, $ne: ""}}, canceledPendingEmailUpdate(now), {returnDocument: "after"})
    if (!updated) {
        logger.warn("Email.cancel", `User ${user._id!.toHexString()}`, "Pending email confirmation was already absent")
        throw createError({statusCode: 409, statusMessage: "There is no pending email confirmation to cancel"})
    }

    logger.info("Email.cancel", `User ${user._id!.toHexString()}`, "Pending email confirmation canceled")
    return updated
}
