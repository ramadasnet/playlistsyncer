// Fetch configured providers and expose a reactive availability check.
import type {Provider} from "~~/shared/types/domain"

// Load provider availability for account and task forms.
export async function useEnabledProviders() {
    const {data} = await useFetch<{providers: Provider[]; extensionProviders?: Provider[]}>("/api/providers", {key: "enabled-providers"})
    const enabledProviders = computed(() => data.value?.providers ?? [])
    // Providers that the browser extension can connect, empty when the extension feature is off.
    const extensionProviders = computed(() => data.value?.extensionProviders ?? [])

    function isProviderEnabled(provider: Provider) {
        return enabledProviders.value.includes(provider)
    }

    return {enabledProviders, extensionProviders, isProviderEnabled}
}
