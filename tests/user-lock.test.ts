import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import {withUserLock} from "../server/utils/user-lock"

describe("per-user lock", () => {
    test("runs one user's actions in order and lets another user proceed", async () => {
        const userId = new ObjectId()
        const otherId = new ObjectId()
        const order: string[] = []
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const first = withUserLock(userId, async () => {
            order.push("first-start")
            await gate
            order.push("first-end")
        })
        const second = withUserLock(userId, async () => {
            order.push("second")
        })
        const other = withUserLock(otherId, async () => {
            order.push("other")
        })

        await other
        expect(order).toEqual(["first-start", "other"])
        release()
        await Promise.all([first, second])
        expect(order).toEqual(["first-start", "other", "first-end", "second"])
    })
})
