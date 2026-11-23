// Passed to Bun with --preload by the website, jobs, and development commands, so secrets are set before configuration is read.
import {preloadInfisicalSecrets} from "./utils/infisical"

await preloadInfisicalSecrets()
