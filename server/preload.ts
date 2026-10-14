// Passed to Bun with --preload by the website, jobs, and development commands, so secrets are set before configuration is read.
import {infisicalLoadedKeysEnv, loadInfisicalSecrets} from "./utils/infisical"

const loadedKeys = await loadInfisicalSecrets()
if (process.env.PLS_INFISICAL_CLIENT_ID) {
    process.env[infisicalLoadedKeysEnv] = JSON.stringify(loadedKeys)
}
