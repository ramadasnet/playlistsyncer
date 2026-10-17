import {defineEventHandler, sendRedirect} from "h3"
import {beginAdminLogin} from "../../utils/auth"

export default defineEventHandler(async (event) => sendRedirect(event, await beginAdminLogin(event)))
