import {describe, expect, test} from "bun:test"
import {decryptSecret, encryptSecret} from "../server/utils/secrets"

describe("encrypted secrets", () => {
    const key = "any configured value works"

    test("round trips without storing plaintext", async () => {
        const encrypted = await encryptSecret("refresh-token", key)

        expect(encrypted.version).toBe(2)
        expect(encrypted.ciphertext).not.toContain("refresh-token")
        expect(await decryptSecret(encrypted, key)).toBe("refresh-token")
    })

    test("derives a valid key from short arbitrary strings", async () => {
        const encrypted = await encryptSecret("secret", "short")

        expect(await decryptSecret(encrypted, "short")).toBe("secret")
        expect(decryptSecret(encrypted, "different")).rejects.toThrow()
    })

    test("rejects unknown ciphertext versions", async () => {
        const encrypted = await encryptSecret("secret", key)

        expect(decryptSecret({...encrypted, version: 99}, key)).rejects.toThrow("Unsupported encrypted value version: 99")
    })
})
