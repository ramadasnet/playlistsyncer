import {describe, expect, spyOn, test} from "bun:test"
import {ObjectId} from "mongodb"
import logger from "../server/utils/logger"

// Capture the formatted console lines that one logging call produces.
function capture(log: () => void): string {
    const output: string[] = []
    const write = spyOn(logger, "console").mockImplementation((_level: string, message: string) => {
        output.push(message)
    })
    try {
        log()
    } finally {
        write.mockRestore()
    }
    return output.join("\n")
}

const secrets = {
    accessToken: "access-secret",
    refresh_token: "refresh-secret",
    clientSecret: "client-secret",
    codeVerifier: "verifier-secret",
    tokenEncryptionKey: "encryption-secret",
    nested: [{Authorization: "Bearer header-secret", smtpPassword: "smtp-secret"}]
}

describe("logger secret masking", () => {
    for (const level of ["info", "warn", "error"] as const) {
        test(`masks camelCase and snake_case secret fields on ${level}`, () => {
            const line = capture(() => logger[level]("Logger.test", {...secrets, provider: "spotify"}))

            expect(line).toContain("spotify")
            expect(line).toContain("[***]")
            for (const secret of ["access-secret", "refresh-secret", "client-secret", "verifier-secret", "encryption-secret", "header-secret", "smtp-secret"]) {
                expect(line).not.toContain(secret)
            }
        })
    }

    test("keeps the logged object and non-plain values intact", () => {
        const id = new ObjectId()
        const payload = {accessToken: "access-secret", userId: id}

        const line = capture(() => logger.info("Logger.test", payload))

        expect(line).toContain(id.toHexString())
        expect(payload.accessToken).toBe("access-secret")
    })
})
