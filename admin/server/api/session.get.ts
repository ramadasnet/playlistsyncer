import {defineEventHandler, isError} from "h3"
import {getServerConfig} from "../../../server/utils/config"
import {requireAdmin} from "../utils/auth"

export default defineEventHandler(async (event) => {
    try {
        return {admin: await requireAdmin(event), creemServer: getServerConfig().creemServer}
    } catch (error) {
        if (isError(error) && error.statusCode === 401) return {admin: null, creemServer: null}
        throw error
    }
})
