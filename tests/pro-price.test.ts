import {describe, expect, mock, test} from "bun:test"
import type {Creem} from "creem"
import {fetchCreemProPrice, formatCreemPrice, loadCreemProPrice} from "../server/domain/billing/pro-price"

function creemClient(items: Array<{price: number; currency: string}>, search = mock(async () => ({result: {items}}))): Pick<Creem, "products"> {
    return {products: {search: search as Creem["products"]["search"]}}
}

describe("Creem PRO price", () => {
    test("formats Creem cents as a currency label", () => {
        expect(formatCreemPrice(999, "usd")).toBe("$9.99")
        expect(formatCreemPrice(1000, "EUR")).toBe("€10.00")
        expect(() => formatCreemPrice(Number.NaN, "USD")).toThrow("Creem product price is not a number")
    })

    test("uses the first active product", async () => {
        const search = mock(async () => ({
            result: {
                items: [
                    {price: 1299, currency: "EUR"},
                    {price: 100, currency: "USD"}
                ]
            }
        }))
        const price = await fetchCreemProPrice(creemClient([], search))

        expect(price).toBe("€12.99")
        expect(search).toHaveBeenCalledWith(1, 1, "active", {timeoutMs: 10_000, retries: {strategy: "none"}})
    })

    test("returns nothing when Creem has no product", async () => {
        await expect(fetchCreemProPrice(creemClient([]))).resolves.toBeUndefined()
    })

    test("keeps the env price when Creem is disabled or the lookup fails", async () => {
        const search = mock(async () => ({result: {items: [{price: 1299, currency: "EUR"}]}}))

        await expect(loadCreemProPrice(false, creemClient([], search))).resolves.toBeUndefined()
        expect(search).not.toHaveBeenCalled()

        await expect(loadCreemProPrice(true, creemClient([]))).resolves.toBeUndefined()
        await expect(
            loadCreemProPrice(true, {
                products: {
                    search: (async () => {
                        throw new Error("creem down")
                    }) as Creem["products"]["search"]
                }
            })
        ).resolves.toBeUndefined()
    })
})
