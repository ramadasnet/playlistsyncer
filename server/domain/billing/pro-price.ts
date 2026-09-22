// Load the public PRO price from the single Creem subscription product.
import type {Creem} from "creem"
import logger from "../../utils/logger"
import {getCreem} from "./creem"

const priceLookupTimeoutMs = 10_000

// Format a Creem price, stored in cents, as a currency label.
export function formatCreemPrice(priceCents: number, currency: string): string {
    if (!Number.isFinite(priceCents)) {
        throw new Error("Creem product price is not a number")
    }
    return new Intl.NumberFormat("en", {style: "currency", currency: currency.toUpperCase()}).format(priceCents / 100)
}

// Read the price of the first active Creem product.
export async function fetchCreemProPrice(creem: Pick<Creem, "products"> = getCreem()): Promise<string | undefined> {
    const page = await creem.products.search(1, 1, "active", {timeoutMs: priceLookupTimeoutMs, retries: {strategy: "none"}})
    const product = page.result.items[0]
    if (!product) {
        return undefined
    }
    return formatCreemPrice(product.price, product.currency)
}

// Resolve the startup price, leaving it unset when Creem is disabled or the lookup fails.
export async function loadCreemProPrice(creemEnabled: boolean, creem?: Pick<Creem, "products">): Promise<string | undefined> {
    if (!creemEnabled) {
        return undefined
    }
    try {
        const price = await fetchCreemProPrice(creem)
        if (!price) {
            logger.warn("Creem.proPrice", "No product returned; using the configured PRO price")
            return undefined
        }
        logger.info("Creem.proPrice", `Loaded ${price}`)
        return price
    } catch (error) {
        logger.error("Creem.proPrice", error, "Failed to load the PRO price; using the configured value")
        return undefined
    }
}
