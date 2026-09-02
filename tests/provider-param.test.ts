import {describe, expect, test} from "bun:test"
import {providers} from "../shared/types/domain"

describe("provider identifiers", () => {
    test("remain stable for routes, persisted documents, and display order", () => {
        expect(providers).toEqual(["spotify", "amazon", "youtube", "tidal"])
    })
})
