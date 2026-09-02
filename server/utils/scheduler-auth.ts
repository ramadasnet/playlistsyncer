import {createHash, timingSafeEqual} from "node:crypto"
import type {H3Event} from "h3"
import {requireConfig} from "./config"

export function requireScheduler(event: H3Event): void {
    const provided = getHeader(event, "authorization")?.replace(/^Bearer\s+/i, "") || ""
    const expected = requireConfig("schedulerSecret")
    const providedHash = createHash("sha256").update(provided).digest()
    const expectedHash = createHash("sha256").update(expected).digest()
    if (!provided || !timingSafeEqual(providedHash, expectedHash)) {
        throw createError({statusCode: 401, statusMessage: "Invalid scheduler authorization"})
    }
}
