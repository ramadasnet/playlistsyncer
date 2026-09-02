import {getCurrentUser, serializeUser} from "../domain/auth/session"

export default defineEventHandler(async (event) => {
    const user = await getCurrentUser(event)
    return {user: user ? serializeUser(user) : null}
})
