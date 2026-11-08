// Provider hosts used by the manifest, the tab helper and the request listeners.

// Amazon Music storefront domain suffixes.
export const amazonTlds = ["com", "ca", "com.br", "com.mx", "co.uk", "de", "fr", "it", "es", "in", "co.jp", "com.au"]

export const spotifyPatterns = ["https://*.spotify.com/*"]
export const amazonTabPatterns = amazonTlds.map((tld) => `https://music.amazon.${tld}/*`)
export const amazonGqlPatterns = amazonTlds.map((tld) => `https://gql.music.amazon.${tld}/*`)

// Host permissions of the extension, for the given PlaylistSyncer server origin.
export function hostPermissions(serverOrigin: string): string[] {
    return [...spotifyPatterns, ...amazonTabPatterns, ...amazonGqlPatterns, `${serverOrigin}/*`]
}
