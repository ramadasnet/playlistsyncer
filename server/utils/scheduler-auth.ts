// Authenticate internal scheduler requests without exposing the secret directly.
import {createHash, timingSafeEqual} from "node:crypto"
import {createError, getHeader, type H3Event} from "h3"
import {requireConfig} from "./config"

// Require a bearer token that matches the configured scheduler secret.
export function requireScheduler(event: H3Event): void {
    const provided = getHeader(event, "authorization")?.replace(/^Bearer\s+/i, "") || ""
    const expected = requireConfig("schedulerSecret")
    const providedHash = createHash("sha256").update(provided).digest()
    const expectedHash = createHash("sha256").update(expected).digest()
    if (!provided || !timingSafeEqual(providedHash, expectedHash)) {
        throw createError({statusCode: 401, statusMessage: "Invalid scheduler authorization"})
    }
}
