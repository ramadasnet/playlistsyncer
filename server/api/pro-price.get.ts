// Expose the Creem-resolved PRO price so client-side navigation observes it instead of the baked fallback.
import {getResolvedProPrice} from "../domain/billing/pro-price"

export default defineEventHandler(() => {
    return {proPrice: getResolvedProPrice()}
})
