// Drain in-flight sync runs before the website exits. The Bun entry has no signal handling of its own.
import {getServerConfig} from "../utils/config"
import logger from "../utils/logger"
import {drainSyncRuns} from "../utils/shutdown"

// Wait for background runs, close Nitro (database, tunnel), then exit.
export default defineNitroPlugin((nitroApp) => {
    if (import.meta.dev) {
        return
    }
    const shutdown = async (signal: string) => {
        logger.info("PlaylistSync.shutdown", signal)
        await drainSyncRuns(getServerConfig().shutdownTimeoutSeconds * 1000)
        await nitroApp.hooks.callHook("close")
        process.exit(0)
    }
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
    process.once("SIGINT", () => void shutdown("SIGINT"))
})
