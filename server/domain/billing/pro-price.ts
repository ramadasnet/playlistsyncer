// Load the public PRO price from the configured Creem subscription product.
import type {Creem} from "creem"
import logger from "../../utils/logger"
import {getCreem} from "./creem"

const priceLookupTimeoutMs = 10_000

// Format a Creem price, stored in cents, as an amount followed by its currency code.
export function formatCreemPrice(priceCents: number, currency: string): string {
    if (!Number.isFinite(priceCents)) {
        throw new Error("Creem product price is not a number")
    }
    const code = currency.toUpperCase()
    const parts = new Intl.NumberFormat("en", {style: "currency", currency: code}).formatToParts(priceCents / 100)
    const amount = parts
        .filter((part) => part.type !== "currency")
        .map((part) => part.value)
        .join("")
        .trim()
    return `${amount} ${code}`
}

// Read the price of the PRO product that checkout charges.
export async function fetchCreemProPrice(productId: string, creem: Pick<Creem, "products"> = getCreem()): Promise<string> {
    const product = await creem.products.get(productId, {timeoutMs: priceLookupTimeoutMs, retries: {strategy: "none"}})
    return formatCreemPrice(product.price, product.currency)
}

// Resolve the startup price, leaving it unset when Creem is disabled or the lookup fails.
export async function loadCreemProPrice(creemEnabled: boolean, productId: string | undefined, creem?: Pick<Creem, "products">): Promise<string | undefined> {
    if (!creemEnabled) {
        return undefined
    }
    if (!productId) {
        logger.warn("Creem.proPrice", "No PRO product configured; using the configured PRO price")
        return undefined
    }
    try {
        const price = await fetchCreemProPrice(productId, creem)
        logger.info("Creem.proPrice", `Loaded ${price}`)
        return price
    } catch (error) {
        logger.error("Creem.proPrice", error, "Failed to load the PRO price; using the configured value")
        return undefined
    }
}
