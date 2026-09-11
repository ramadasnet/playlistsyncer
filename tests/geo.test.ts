import {describe, expect, test} from "bun:test"
import {countryFromHeaders, normalizeCountryCode, shouldShowImpressum} from "../shared/geo"

describe("visitor country from request headers", () => {
    test("prefers Cloudflare CF-IPCountry when several geo headers are present", () => {
        expect(
            countryFromHeaders({
                "cf-ipcountry": "DE",
                "x-vercel-ip-country": "US",
                "cloudfront-viewer-country": "AT"
            })
        ).toBe("DE")
    })

    test("falls back to other CDN country headers and ignores unknown Cloudflare codes", () => {
        expect(countryFromHeaders({"CF-IPCountry": "at"})).toBe("AT")
        expect(countryFromHeaders({"x-vercel-ip-country": "AT"})).toBe("AT")
        expect(countryFromHeaders({"cloudfront-viewer-country": "DE"})).toBe("DE")
        expect(countryFromHeaders({"cf-ipcountry": "XX", "x-vercel-ip-country": "DE"})).toBe("DE")
        expect(countryFromHeaders({"cf-ipcountry": "T1"})).toBeNull()
        expect(countryFromHeaders({})).toBeNull()
        expect(normalizeCountryCode("deu")).toBeNull()
        expect(normalizeCountryCode("  de ")).toBe("DE")
    })

    test("shows the Impressum link only for Germany and Austria", () => {
        expect(shouldShowImpressum("DE")).toBe(true)
        expect(shouldShowImpressum("AT")).toBe(true)
        expect(shouldShowImpressum("CH")).toBe(false)
        expect(shouldShowImpressum("US")).toBe(false)
        expect(shouldShowImpressum(null)).toBe(false)
    })
})
