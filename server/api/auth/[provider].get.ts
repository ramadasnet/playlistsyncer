import {beginOAuth} from "../../domain/auth/oauth"
import {getProviderParam} from "../../utils/provider-param"

export default defineEventHandler(async (event) =>
    sendRedirect(event, await beginOAuth(event, getProviderParam(event)))
)
