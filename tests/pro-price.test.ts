import {describe, expect, mock, test} from "bun:test"
import type {Creem} from "creem"
import {fetchCreemProPrice, formatCreemPrice, loadCreemProPrice} from "../server/domain/billing/pro-price"

function creemClient(product?: {price: number; currency: string}, get = mock(async () => product!)): Pick<Creem, "products"> {
    return {products: {get: get as unknown as Creem["products"]["get"]} as Creem["products"]}
}

describe("Creem PRO price", () => {
    test("formats Creem cents as an amount with its currency code", () => {
        expect(formatCreemPrice(999, "usd")).toBe("9.99 USD")
        expect(formatCreemPrice(1000, "EUR")).toBe("10.00 EUR")
        expect(formatCreemPrice(123456, "EUR")).toBe("1,234.56 EUR")
        expect(() => formatCreemPrice(Number.NaN, "USD")).toThrow("Creem product price is not a number")
    })

    test("uses the configured PRO product", async () => {
        const get = mock(async () => ({price: 1299, currency: "EUR"}))
        const price = await fetchCreemProPrice("prod_pro", creemClient(undefined, get))

        expect(price).toBe("12.99 EUR")
        expect(get).toHaveBeenCalledWith("prod_pro", {timeoutMs: 10_000, retries: {strategy: "none"}})
    })

    test("keeps the env price when Creem is disabled, unconfigured, or the lookup fails", async () => {
        const get = mock(async () => ({price: 1299, currency: "EUR"}))

        await expect(loadCreemProPrice(false, "prod_pro", creemClient(undefined, get))).resolves.toBeUndefined()
        await expect(loadCreemProPrice(true, undefined, creemClient(undefined, get))).resolves.toBeUndefined()
        expect(get).not.toHaveBeenCalled()

        await expect(
            loadCreemProPrice(
                true,
                "prod_pro",
                creemClient(
                    undefined,
                    mock(async () => {
                        throw new Error("creem down")
                    })
                )
            )
        ).resolves.toBeUndefined()
    })
})
