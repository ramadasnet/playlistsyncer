// Begin provider OAuth authorization with a safe redirect state.
import {beginOAuth} from "../../domain/auth/oauth"
import {getProviderParam} from "../../utils/provider-param"

// Redirect the browser to the selected provider's authorization endpoint.
export default defineEventHandler(async (event) => sendRedirect(event, await beginOAuth(event, getProviderParam(event))))
