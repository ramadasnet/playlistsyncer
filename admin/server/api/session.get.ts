import {defineEventHandler, isError} from "h3"
import {requireAdmin} from "../utils/auth"

export default defineEventHandler(async (event) => {
    try {
        return {admin: await requireAdmin(event)}
    } catch (error) {
        if (isError(error) && error.statusCode === 401) return {admin: null}
        throw error
    }
})
