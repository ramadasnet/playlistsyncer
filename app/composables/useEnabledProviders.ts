import type {Provider} from "~~/shared/types/domain"

export async function useEnabledProviders() {
    const {data} = await useFetch<{providers: Provider[]}>("/api/providers", {key: "enabled-providers"})
    const enabledProviders = computed(() => data.value?.providers ?? [])

    function isProviderEnabled(provider: Provider) {
        return enabledProviders.value.includes(provider)
    }

    return {enabledProviders, isProviderEnabled}
}
