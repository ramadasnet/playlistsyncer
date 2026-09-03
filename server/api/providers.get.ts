import {enabledProviders} from "../utils/provider-availability"

export default defineEventHandler(() => ({
    providers: enabledProviders()
}))
