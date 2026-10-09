// Configure structured, secret-masking application logging.
import logger from "anyhow"

// Keys are compared lowercased, so camelCase and snake_case spellings of the same field both match.
const maskedFields = new Set(
    [
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "id_token",
        "token",
        "authorization",
        "password",
        "secret",
        "clientSecret",
        "client_secret",
        "codeVerifier",
        "code_verifier",
        "sessionSecret",
        "tokenEncryptionKey",
        "schedulerSecret",
        "creemApiKey",
        "creemWebhookSecret",
        "smtpPassword",
        "emailVerificationTokenHash",
        "confirmationToken"
    ].map((field) => field.toLowerCase())
)

// Return a copy of plain objects and arrays with secret fields replaced, leaving class instances such as ObjectId untouched.
function maskSecrets(value: unknown, depth = 0): unknown {
    if (depth > 10 || value === null || typeof value !== "object") {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => maskSecrets(item, depth + 1))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        return value
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedFields.has(key.toLowerCase()) && (item === null || typeof item !== "object") ? "[***]" : maskSecrets(item, depth + 1)]))
}

logger.setup("console")
logger.setOptions({
    appName: "PlaylistSync",
    timestamp: process.env.NODE_ENV !== "production",
    levelOnConsole: true,
    // anyhow 3.4 skips its built-in maskSecrets on info and debug, so masking runs as a custom preprocessor on every level.
    preprocessors: ["friendlyErrors", (args: unknown[]) => args.map((arg) => maskSecrets(arg))],
    uncaughtExceptions: true,
    unhandledRejections: true
})

if (process.env.NODE_ENV === "production" && process.env.PLS_JSON_LOGGING === "true") {
    logger.setOptions({levelOnConsole: false})
    logger.setup({
        name: "gcloud",
        log(level: string, message: string) {
            const severity = level.toUpperCase() === "WARN" ? "WARNING" : level.toUpperCase()
            console.log(JSON.stringify({severity, message}))
        }
    })
}

export default logger
