// Expose provider integrations that are configured for this deployment.
import {enabledProviders} from "../utils/provider-availability"

export default defineEventHandler(() => ({
    providers: enabledProviders()
}))
