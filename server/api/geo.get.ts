// Resolve the visitor country used to display the regional legal notice.
import {countryFromHeaders, shouldShowImpressum, visitorCountryHeaders} from "../../shared/geo"

// Keep geo-derived presentation data private and uncached.
export default defineEventHandler((event) => {
    const headers: Record<string, string | undefined> = {}
    for (const name of visitorCountryHeaders) {
        headers[name] = getHeader(event, name)
    }

    const country = countryFromHeaders(headers)
    setResponseHeaders(event, {"Cache-Control": "private, no-store"})
    return {country, showImpressum: shouldShowImpressum(country)}
})
