// Deliver transactional email when SMTP is configured.
import nodemailer from "nodemailer"
import {getServerConfig, type ServerConfig} from "../../utils/config"
import logger from "../../utils/logger"

export interface OutboundEmail {
    to: string
    subject: string
    text: string
    html: string
}

// Check whether an SMTP host and sender address are configured.
export function isMailConfigured(config: Pick<ServerConfig, "smtpHost" | "smtpFrom"> = getServerConfig()): boolean {
    return Boolean(config.smtpHost && (config.smtpFrom || process.env.PLS_SUPPORT_EMAIL))
}

function mailFrom(config: ServerConfig): string {
    return config.smtpFrom || `PlaylistSyncer <${process.env.PLS_SUPPORT_EMAIL}>`
}

// Send an email and report whether delivery was attempted.
export async function sendMail(message: OutboundEmail, config: ServerConfig = getServerConfig()): Promise<boolean> {
    if (!isMailConfigured(config)) {
        logger.warn("Mail.send", "SMTP host or sender address is not configured; message was not delivered")
        return false
    }

    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        // StartTLS on message submission ports so credentials and content are never sent in the clear.
        requireTLS: config.smtpPort !== 465,
        auth: config.smtpUser && config.smtpPassword ? {user: config.smtpUser, pass: config.smtpPassword} : undefined
    })
    await transporter.sendMail({
        from: mailFrom(config),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html
    })
    logger.info("Mail.send", "Message delivered")
    return true
}
