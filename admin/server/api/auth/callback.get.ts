import {defineEventHandler, sendRedirect} from "h3"
import {finishAdminLogin} from "../../utils/auth"

export default defineEventHandler(async (event) => {
    await finishAdminLogin(event)
    return sendRedirect(event, "/")
})
