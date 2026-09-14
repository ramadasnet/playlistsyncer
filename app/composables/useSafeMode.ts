// Expose the process-wide SAFE_MODE flag to Vue components.

import {isPublicSafeMode} from "~~/shared/env-flag"

// Read whether music-provider writes are blocked for this deployment.
export function useSafeMode() {
    const config = useRuntimeConfig()
    const safeMode = computed(() => isPublicSafeMode(config.public.safeMode))
    return {safeMode}
}
