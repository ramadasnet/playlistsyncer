import {describe, expect, test} from "bun:test"
import {
    enabledProviders,
    formatProviderNames,
    isProviderEnabled,
    providerFlags,
    providers
} from "../shared/types/domain"

describe("provider identifiers", () => {
    test("remain stable for routes, persisted documents, and display order", () => {
        expect(providers).toEqual(["spotify", "tidal", "youtube", "amazon"])
    })

    test("can hide a provider from the product without removing it from the catalog", () => {
        expect(providerFlags.amazon.disabled).toBe(true)
        expect(isProviderEnabled("amazon")).toBe(false)
        expect(enabledProviders).toEqual(["spotify", "tidal", "youtube"])
        expect(enabledProviders.every(isProviderEnabled)).toBe(true)
        expect(providers.filter((provider) => !isProviderEnabled(provider))).toEqual(["amazon"])
    })

    test("formats enabled provider names for product copy", () => {
        expect(formatProviderNames()).toBe("Spotify, TIDAL, and YouTube Music")
        expect(formatProviderNames(["spotify", "tidal"])).toBe("Spotify and TIDAL")
        expect(formatProviderNames(["spotify"])).toBe("Spotify")
    })
})
