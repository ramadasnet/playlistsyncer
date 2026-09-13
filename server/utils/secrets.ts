// Encrypt provider credentials with AES-GCM and support legacy key material.
import type {EncryptedValue} from "~~/shared/types/domain"
import {requireConfig} from "./config"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodeBase64(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url")
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(value, "base64url"))
}

async function importLegacyKey(encodedKey: string): Promise<CryptoKey> {
    const key = decodeBase64(encodedKey)
    if (key.byteLength !== 32) {
        throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key")
    }
    return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"])
}

async function deriveKey(value: string): Promise<CryptoKey> {
    const key = await crypto.subtle.digest("SHA-256", encoder.encode(value))
    return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"])
}

// Encrypt a secret using a fresh IV and the current key derivation scheme.
export async function encryptSecret(
    value: string,
    encodedKey = requireConfig("tokenEncryptionKey")
): Promise<EncryptedValue> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
        {name: "AES-GCM", iv},
        await deriveKey(encodedKey),
        encoder.encode(value)
    )
    return {
        version: 2,
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(ciphertext))
    }
}

// Decrypt both current and legacy encrypted secret representations.
export async function decryptSecret(
    value: EncryptedValue,
    encodedKey = requireConfig("tokenEncryptionKey")
): Promise<string> {
    let key: CryptoKey
    if (value.version === 1) {
        key = await importLegacyKey(encodedKey)
    } else if (value.version === 2) {
        key = await deriveKey(encodedKey)
    } else {
        throw new Error(`Unsupported encrypted value version: ${value.version}`)
    }
    const plaintext = await crypto.subtle.decrypt(
        {name: "AES-GCM", iv: decodeBase64(value.iv)},
        key,
        decodeBase64(value.ciphertext)
    )
    return decoder.decode(plaintext)
}
