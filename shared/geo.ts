// Prefer Cloudflare's CF-IPCountry: this app is served through Cloudflare, the header is
// already on the request, and it avoids sending visitor IPs to a third-party geo API.
// Headers populated by supported proxies with the visitor's country code.
export const visitorCountryHeaders = ["cf-ipcountry", "cloudfront-viewer-country"] as const

const impressumCountries = new Set(["DE", "AT"])
const unknownCountryCodes = new Set(["XX", "T1", "ZZ"])

// Normalize a proxy country value and discard unknown or malformed codes.
export function normalizeCountryCode(value: string | undefined | null): string | null {
    const country = value?.trim().toUpperCase()
    if (!country || unknownCountryCodes.has(country) || !/^[A-Z]{2}$/.test(country)) {
        return null
    }
    return country
}

// Read the first usable country code from proxy headers.
export function countryFromHeaders(headers: Record<string, string | undefined | null>): string | null {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    for (const name of visitorCountryHeaders) {
        const country = normalizeCountryCode(normalized[name])
        if (country) {
            return country
        }
    }
    return null
}

// Determine whether the legal notice should be shown for a country.
export function shouldShowImpressum(country: string | null): boolean {
    return country !== null && impressumCountries.has(country)
}
