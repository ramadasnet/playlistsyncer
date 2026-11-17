// Notify configured webhooks about user registrations, logins, and account deletions.
import type {UserDocument} from "~~/shared/types/domain"
import {getServerConfig} from "../utils/config"
import {fetchWithRetry} from "../utils/fetch-retry"
import logger from "../utils/logger"

export type UserEventType = "user.registered" | "user.login" | "user.deleted"

// Public profile fields posted to webhook receivers; no tokens or pending verification data.
function webhookUser(user: UserDocument) {
    return {
        id: user._id?.toHexString(),
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        spotifyClientId: user.spotifyClientId,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt
    }
}

// POST the event payload to every configured webhook. Delivery failures are logged, never thrown,
// so a broken receiver cannot block a registration, login, or deletion. Retries are off so a slow receiver cannot delay them either.
export async function sendUserEventWebhooks(event: UserEventType, user: UserDocument): Promise<void> {
    const urls = getServerConfig().userWebhookUrls
    if (!urls.length) {
        return
    }
    const body = JSON.stringify({event, timestamp: new Date().toISOString(), user: webhookUser(user)})
    await Promise.all(
        urls.map(async (url) => {
            try {
                const response = await fetchWithRetry(url, {method: "POST", headers: {"Content-Type": "application/json"}, body}, {label: "UserWebhook.post", timeoutMs: 10_000, maxRetries: 0})
                if (!response.ok) {
                    logger.warn("UserWebhook.post", event, `User ${user._id?.toHexString()}`, url, `Status ${response.status}`)
                }
            } catch (error) {
                logger.warn("UserWebhook.post", event, `User ${user._id?.toHexString()}`, url, error)
            }
        })
    )
}
