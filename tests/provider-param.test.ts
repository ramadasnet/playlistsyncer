import {describe, expect, test} from "bun:test"
import {providers} from "../shared/types/domain"

describe("provider identifiers", () => {
    test("remain stable for routes and persisted documents", () => {
        expect(providers).toEqual(["amazon", "spotify", "youtube"])
    })
})
