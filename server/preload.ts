// Bun runs this before every entry point (see bunfig.toml), so Infisical secrets are set before any configuration is read.
import {infisicalLoadedKeysEnv, loadInfisicalSecrets} from "./utils/infisical"

const loadedKeys = await loadInfisicalSecrets()
if (process.env.PLS_INFISICAL_CLIENT_ID) {
    process.env[infisicalLoadedKeysEnv] = JSON.stringify(loadedKeys)
}
