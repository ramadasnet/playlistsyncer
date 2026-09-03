import {describe, expect, test} from "bun:test"
import {formatProviderNames, isProviderFlagEnabled, providerFlags, providers} from "../shared/types/domain"

describe("provider identifiers", () => {
    test("remain stable for routes, persisted documents, and display order", () => {
        expect(providers).toEqual(["spotify", "tidal", "youtube", "amazon"])
    })

    test("can hide a provider from the product without removing it from the catalog", () => {
        expect(providerFlags.amazon.disabled).toBe(true)
        expect(isProviderFlagEnabled("amazon")).toBe(false)
        expect(providers.filter(isProviderFlagEnabled)).toEqual(["spotify", "tidal", "youtube"])
    })

    test("formats enabled provider names for product copy", () => {
        expect(formatProviderNames(["spotify", "tidal", "youtube"])).toBe("Spotify, TIDAL, and YouTube Music")
        expect(formatProviderNames(["spotify", "tidal"])).toBe("Spotify and TIDAL")
        expect(formatProviderNames(["spotify"])).toBe("Spotify")
        expect(formatProviderNames([])).toBe("")
    })
})
