import {describe, expect, test} from "bun:test"
import type {EncryptedValue} from "../shared/types/domain"
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

    test("decrypts legacy base64url-key ciphertexts", async () => {
        const legacyKey = Buffer.alloc(32, 7)
        const iv = new Uint8Array(12).fill(3)
        const cryptoKey = await crypto.subtle.importKey("raw", legacyKey, "AES-GCM", false, ["encrypt"])
        const ciphertext = await crypto.subtle.encrypt(
            {name: "AES-GCM", iv},
            cryptoKey,
            new TextEncoder().encode("legacy-token")
        )
        const encrypted: EncryptedValue = {
            version: 1,
            iv: Buffer.from(iv).toString("base64url"),
            ciphertext: Buffer.from(ciphertext).toString("base64url")
        }

        expect(await decryptSecret(encrypted, legacyKey.toString("base64url"))).toBe("legacy-token")
    })

    test("rejects unknown ciphertext versions", async () => {
        const encrypted = await encryptSecret("secret", key)

        expect(decryptSecret({...encrypted, version: 99}, key)).rejects.toThrow(
            "Unsupported encrypted value version: 99"
        )
    })
})
