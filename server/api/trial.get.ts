import {getServerConfig} from "../utils/config"

export default defineEventHandler(() => {
    const requiredAt = getServerConfig().proSubscriptionRequiredAt
    return {proSubscriptionRequiredAt: requiredAt?.toISOString() ?? ""}
})
