// Resolve which provider integrations are configured and available.
import {providers, providerFlags, type Provider} from "../../shared/types/domain"
import {hasOAuthCredentials} from "../domain/auth/providers"
import {getServerConfig, type ServerConfig} from "./config"

// Check whether the credentials required by a provider are configured.
export function isProviderEnabled(provider: Provider, config: ServerConfig = getServerConfig()): boolean {
    return !providerFlags[provider].disabled && hasOAuthCredentials(provider, config)
}

// Return providers that can be selected by the current deployment.
export function enabledProviders(config: ServerConfig = getServerConfig()): Provider[] {
    return providers.filter((provider) => isProviderEnabled(provider, config))
}
