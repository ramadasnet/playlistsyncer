import {providers, providerFlags, type Provider} from "../../shared/types/domain"
import {hasOAuthCredentials} from "../domain/auth/providers"
import {getServerConfig, type ServerConfig} from "./config"

export function isProviderEnabled(provider: Provider, config: ServerConfig = getServerConfig()): boolean {
    return !providerFlags[provider].disabled && hasOAuthCredentials(provider, config)
}

export function enabledProviders(config: ServerConfig = getServerConfig()): Provider[] {
    return providers.filter((provider) => isProviderEnabled(provider, config))
}
