import {createHmac, randomBytes} from "node:crypto"
import type {H3Event} from "h3"
import {ObjectId} from "mongodb"
import {collections} from "../../data/collections"
import {requireConfig} from "../../utils/config"
import logger from "../../utils/logger"
import {resolveEntitlement} from "../billing/entitlement"

const sessionCookie = "ps_session"
const sessionDurationSeconds = 60 * 60 * 24 * 30

export function hashOpaqueToken(value: string, secret = requireConfig("sessionSecret")): string {
    return createHmac("sha256", secret).update(value).digest("base64url")
}

export async function createSession(event: H3Event, userId: ObjectId): Promise<void> {
    const token = randomBytes(32).toString("base64url")
    const now = new Date()
    const db = await collections()
    await db.sessions.insertOne({
        userId,
        tokenHash: hashOpaqueToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + sessionDurationSeconds * 1000)
    })
    setCookie(event, sessionCookie, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationSeconds
    })
    logger.info("Session.create", `User ${userId.toHexString()}`)
}

export async function getCurrentUser(event: H3Event) {
    const token = getCookie(event, sessionCookie)
    if (!token) {
        return null
    }
    const db = await collections()
    const session = await db.sessions.findOne({tokenHash: hashOpaqueToken(token), expiresAt: {$gt: new Date()}})
    if (!session) {
        logger.warn("Session.getCurrentUser", "Expired or unknown session cookie")
        deleteCookie(event, sessionCookie, {path: "/"})
        return null
    }
    return db.users.findOne({_id: new ObjectId(session.userId)})
}

export async function requireUser(event: H3Event) {
    const user = await getCurrentUser(event)
    if (!user) {
        throw createError({statusCode: 401, statusMessage: "Authentication required"})
    }
    return user
}

export async function destroySession(event: H3Event): Promise<void> {
    const token = getCookie(event, sessionCookie)
    if (token) {
        const db = await collections()
        const result = await db.sessions.deleteOne({tokenHash: hashOpaqueToken(token)})
        logger.info("Session.destroy", result.deletedCount ? "Session deleted" : "Session was already absent")
    }
    deleteCookie(event, sessionCookie, {path: "/"})
}

export function serializeUser(user: Awaited<ReturnType<typeof requireUser>>) {
    const entitlement = resolveEntitlement(user)
    return {
        id: user._id?.toHexString(),
        email: user.email,
        tempEmail: user.tempEmail,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        tier: entitlement.tier,
        developmentProOverride: entitlement.developmentOverride,
        weeklySyncSummaryEnabled: Boolean(user.weeklySyncSummaryEnabled),
        creemSubscriptionStatus: user.creemSubscriptionStatus
    }
}
