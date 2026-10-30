// Expose provider integrations that are configured for this deployment.
import {extensionProviders} from "~~/shared/types/extension"
import {isExtensionEnabled} from "../domain/extension/clients"
import {enabledProviders} from "../utils/provider-availability"

export default defineEventHandler(() => ({
    providers: enabledProviders(),
    extensionProviders: isExtensionEnabled() ? [...extensionProviders] : []
}))
