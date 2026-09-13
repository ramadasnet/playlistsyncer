import {describe, expect, test} from "bun:test"
import {
    buildConfirmationEmail,
    confirmedEmailUpdate,
    emailConfirmationResendCooldownMs,
    emailConfirmationTtlMs,
    evaluateEmailConfirmationToken,
    evaluatePendingEmailRequest,
    normalizeAccountEmail,
    pendingEmailUpdate,
    prepareEmailConfirmation
} from "../server/domain/auth/email"
import {hasVerifiedProviderEmail, newUserFromOAuthProfile, oauthRedirectAfterLogin} from "../server/domain/auth/oauth"
import {isMailConfigured} from "../server/domain/mail/send"

const now = new Date("2026-09-07T12:00:00.000Z")
const secret = "test-session-secret"

describe("OAuth registration without a provider email", () => {
    test("creates a user document without email when the provider email is missing", () => {
        const user = newUserFromOAuthProfile({id: "tidal-1", emailVerified: false, displayName: "Tidal Listener"}, now)

        expect(user).not.toHaveProperty("email")
        expect(user.displayName).toBe("Tidal Listener")
        expect(user.tier).toBe("free")
    })

    test("does not trust an unverified provider email", () => {
        expect(hasVerifiedProviderEmail({email: "listener@example.com", emailVerified: false})).toBe(false)
        expect(newUserFromOAuthProfile({id: "amazon-1", email: "listener@example.com", emailVerified: false, displayName: "Amazon user"}, now)).not.toHaveProperty("email")
    })

    test("stores a verified provider email in lowercase", () => {
        expect(hasVerifiedProviderEmail({email: "Listener@Example.com", emailVerified: true})).toBe(true)
        expect(newUserFromOAuthProfile({id: "spotify-1", email: "Listener@Example.com", emailVerified: true, displayName: "Spotify user"}, now).email).toBe("listener@example.com")
    })

    test("sends users without an email to the account page", () => {
        expect(oauthRedirectAfterLogin({}, "/sync")).toBe("/account")
        expect(oauthRedirectAfterLogin({tempEmail: "pending@example.com"}, "/sync")).toBe("/sync")
        expect(oauthRedirectAfterLogin({email: "confirmed@example.com"}, "/features")).toBe("/features")
    })
})

describe("account email confirmation", () => {
    test("normalizes and rejects invalid addresses", () => {
        expect(normalizeAccountEmail("  Alex@Example.com ")).toBe("alex@example.com")
        expect(() => normalizeAccountEmail("not-an-email")).toThrow()
    })

    test("blocks changes after the profile email is confirmed", () => {
        expect(evaluatePendingEmailRequest({email: "alex@example.com"}, "other@example.com", now)).toEqual({
            ok: false,
            statusCode: 409,
            statusMessage: "This account already has a confirmed email address"
        })
    })

    test("rate limits resending the same pending address", () => {
        expect(evaluatePendingEmailRequest({tempEmail: "alex@example.com", emailConfirmationSentAt: now}, "alex@example.com", new Date(now.getTime() + emailConfirmationResendCooldownMs - 1)).ok).toBe(false)
        expect(evaluatePendingEmailRequest({tempEmail: "alex@example.com", emailConfirmationSentAt: now}, "other@example.com", new Date(now.getTime() + 1))).toEqual({ok: true})
        expect(evaluatePendingEmailRequest({tempEmail: "alex@example.com", emailConfirmationSentAt: now}, "alex@example.com", new Date(now.getTime() + emailConfirmationResendCooldownMs))).toEqual({ok: true})
    })

    test("stores the pending address as temp email until the link is confirmed", () => {
        const prepared = prepareEmailConfirmation({
            email: "alex@example.com",
            appUrl: "http://localhost:3007",
            secret,
            now,
            token: "opaque-token"
        })
        const pending = pendingEmailUpdate(prepared, now)
        const confirmed = confirmedEmailUpdate("alex@example.com", now)

        expect(prepared.confirmUrl).toBe("http://localhost:3007/confirm-email?token=opaque-token")
        expect(prepared.message.to).toBe("alex@example.com")
        expect(prepared.message.text).toContain(prepared.confirmUrl)
        expect(pending.$set.tempEmail).toBe("alex@example.com")
        expect(pending.$set).not.toHaveProperty("email")
        expect(confirmed.$set.email).toBe("alex@example.com")
        expect(confirmed.$unset.tempEmail).toBe("")
        expect(confirmed.$unset.emailVerificationTokenHash).toBe("")
    })

    test("rejects missing or expired confirmation tokens without distinguishing them", () => {
        const expired = evaluateEmailConfirmationToken(
            {
                tempEmail: "alex@example.com",
                emailVerificationExpiresAt: now
            },
            now
        )
        const missing = evaluateEmailConfirmationToken(null, now)
        const valid = evaluateEmailConfirmationToken(
            {
                tempEmail: "alex@example.com",
                emailVerificationExpiresAt: new Date(now.getTime() + emailConfirmationTtlMs)
            },
            now
        )

        expect(expired).toEqual(missing)
        expect(expired.ok).toBe(false)
        expect(valid).toEqual({ok: true, email: "alex@example.com"})
    })

    test("builds a confirmation message without embedding extra profile fields", () => {
        const message = buildConfirmationEmail({
            to: "alex@example.com",
            confirmUrl: "http://localhost:3007/confirm-email?token=abc",
            appName: "PlaylistSyncer"
        })

        expect(message.subject).toBe("Confirm your PlaylistSyncer email address")
        expect(message.html).toContain("http://localhost:3007/confirm-email?token=abc")
        expect(message.html).not.toContain("password")
    })
})

describe("mail configuration", () => {
    test("treats SMTP as unconfigured until a host is set", () => {
        expect(isMailConfigured({smtpHost: undefined})).toBe(false)
        expect(isMailConfigured({smtpHost: "smtp.example.com"})).toBe(true)
    })
})
