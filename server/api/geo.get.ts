import {countryFromHeaders, shouldShowImpressum, visitorCountryHeaders} from "../../shared/geo"

export default defineEventHandler((event) => {
    const headers: Record<string, string | undefined> = {}
    for (const name of visitorCountryHeaders) {
        headers[name] = getHeader(event, name)
    }

    const country = countryFromHeaders(headers)
    setResponseHeaders(event, {"Cache-Control": "private, no-store"})
    return {country, showImpressum: shouldShowImpressum(country)}
})
