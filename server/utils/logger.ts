// Configure structured, secret-masking application logging.
import logger from "anyhow"

logger.setup("console")
logger.setOptions({
    appName: "PlaylistSync",
    timestamp: process.env.NODE_ENV !== "production",
    levelOnConsole: true,
    preprocessors: ["friendlyErrors", "maskSecrets"],
    preprocessorOptions: {
        maskedFields: [
            "accessToken",
            "refreshToken",
            "authorization",
            "clientSecret",
            "codeVerifier",
            "sessionSecret",
            "tokenEncryptionKey",
            "schedulerSecret",
            "creemApiKey",
            "creemWebhookSecret",
            "smtpPassword",
            "emailVerificationTokenHash",
            "confirmationToken"
        ]
    },
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
