import {getDatabase} from "../utils/database"

export default defineEventHandler(async (event) => {
    try {
        await getDatabase().then((database) => database.command({ping: 1}))
        return {status: "ready"}
    } catch {
        setResponseStatus(event, 503)
        return {status: "not_ready"}
    }
})
