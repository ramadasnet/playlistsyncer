// Registry of provider connectors. To add a provider, implement ProviderConnector in its own file and list it here.
import type {ExtensionProvider} from "../../../shared/types/extension"
import {amazon} from "./amazon"
import {spotify} from "./spotify"
import type {ProviderConnector} from "./types"

export const connectors: ProviderConnector[] = [spotify, amazon]

// Connector of a provider, if supported.
export function getConnector(provider: ExtensionProvider): ProviderConnector | undefined {
    return connectors.find((c) => c.provider === provider)
}
