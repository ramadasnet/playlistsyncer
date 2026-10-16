// Catalog search text shared by provider adapters and the manual-match dialog.
import type {Provider} from "./types/domain"

const bracketedTitleNoise = /\s*[([][^\])]*(?:official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|hd|hq)[^\])]*[\])]\s*$/i
const trailingTitleNoise = /\s*[-–—]\s*(?:(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er)|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|hd|hq)\s*$/i

// Remove common release and video suffixes before provider searches.
export function searchableTitle(value: string): string {
    let title = value.trim()
    let previous = ""
    while (title !== previous) {
        previous = title
        title = title.replace(bracketedTitleNoise, "").replace(trailingTitleNoise, "").trim()
    }
    return title
}

const searchLabelSeparator = " - "

// Artists included in a catalog text search. YouTube sends every artist; the others send the first.
function searchedArtists(provider: Provider, artists: string[]) {
    const names = artists.map((artist) => artist.trim()).filter(Boolean)
    if (provider === "youtube") return names
    return names[0] ? [names[0]] : []
}

// The text query a provider sends when it searches by title and artist rather than ISRC.
export function catalogSearchQuery(provider: Provider, track: {title: string; artists: string[]}): string {
    const title = searchableTitle(track.title)
    const artists = searchedArtists(provider, track.artists)
    if (provider === "spotify") {
        return [`track:${title}`, artists[0] ? `artist:${artists[0]}` : ""].filter(Boolean).join(" ")
    }
    if (provider === "youtube") {
        return `${artists.join(" ")} ${title}`.trim()
    }
    return [artists[0], title].filter(Boolean).join(" ").trim()
}

// Title and artist as shown in the manual-match search box, for example "Blackbird - Sara Niemietz".
export function catalogSearchLabel(provider: Provider, track: {title: string; artists: string[]}): string {
    const title = searchableTitle(track.title)
    const artist = searchedArtists(provider, track.artists).join(", ")
    if (title && artist) return `${title}${searchLabelSeparator}${artist}`
    return title || artist
}

// Read a search-box value back into the title and artist a catalog search uses.
export function parseCatalogSearchLabel(provider: Provider, value: string): {title: string; artists: string[]} {
    const text = value.trim()
    const splitAt = text.lastIndexOf(searchLabelSeparator)
    if (splitAt < 0) return {title: text, artists: []}
    const title = text.slice(0, splitAt).trim()
    const artist = text.slice(splitAt + searchLabelSeparator.length).trim()
    if (!title || !artist) return {title: text, artists: []}
    const artists =
        provider === "youtube"
            ? artist
                  .split(", ")
                  .map((name) => name.trim())
                  .filter(Boolean)
            : [artist]
    return {title, artists}
}
