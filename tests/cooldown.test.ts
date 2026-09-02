import {describe, expect, test} from "bun:test"
import {freeManualSyncCooldownMs, manualSyncAvailableAt} from "../server/domain/sync/cooldown"

const now = new Date("2026-09-02T12:00:00.000Z")

describe("manual sync cooldown", () => {
    test("blocks Free accounts for 24 hours after a successful sync", () => {
        const lastSuccessAt = new Date(now.getTime() - freeManualSyncCooldownMs + 1)

        expect(manualSyncAvailableAt("free", lastSuccessAt, now)).toEqual(
            new Date(lastSuccessAt.getTime() + freeManualSyncCooldownMs)
        )
    })

    test("allows Free accounts after 24 hours", () => {
        const lastSuccessAt = new Date(now.getTime() - freeManualSyncCooldownMs)

        expect(manualSyncAvailableAt("free", lastSuccessAt, now)).toBeUndefined()
    })

    test("allows a Free account with no successful sync", () => {
        expect(manualSyncAvailableAt("free", undefined, now)).toBeUndefined()
    })

    test("does not restrict PRO accounts", () => {
        expect(manualSyncAvailableAt("pro", now, now)).toBeUndefined()
    })
})
