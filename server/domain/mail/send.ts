import nodemailer from "nodemailer"
import {getServerConfig, type ServerConfig} from "../../utils/config"
import logger from "../../utils/logger"

export interface OutboundEmail {
    to: string
    subject: string
    text: string
    html: string
}

export function isMailConfigured(config: Pick<ServerConfig, "smtpHost"> = getServerConfig()): boolean {
    return Boolean(config.smtpHost)
}

function mailFrom(config: ServerConfig): string {
    return config.smtpFrom || `PlaylistSyncer <${process.env.NUXT_PUBLIC_SUPPORT_EMAIL || "info@playlistsyncer.com"}>`
}

export async function sendMail(message: OutboundEmail, config: ServerConfig = getServerConfig()): Promise<boolean> {
    if (!config.smtpHost) {
        logger.warn("Mail.send", "SMTP is not configured; message was not delivered")
        return false
    }

    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
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
