import {getDatabase} from "../../../server/utils/database"
import {ensureTtlIndexes} from "../../../server/data/collections"
import {adminConfig} from "../utils/config"

export default defineNitroPlugin(async () => {
    const config = adminConfig()
    if (process.env.NODE_ENV === "production" && (!config.googleClientId || !config.googleClientSecret || !config.allowedEmails.length))
        throw new Error("Configure PLS_ADMIN_GOOGLE_CLIENT_ID, PLS_ADMIN_GOOGLE_CLIENT_SECRET and PLS_ADMIN_ALLOWED_EMAILS")
    const database = await getDatabase()
    await database.collection("adminSessions").createIndex({tokenHash: 1}, {unique: true})
    await database.collection("adminLogins").createIndex({stateHash: 1}, {unique: true})
    await database.collection("adminAudit").createIndex({createdAt: -1})
    await ensureTtlIndexes([database.collection("adminSessions").createIndex({expiresAt: 1}, {expireAfterSeconds: 0}), database.collection("adminLogins").createIndex({expiresAt: 1}, {expireAfterSeconds: 0})])
    // Expiry is also checked on reads, including databases without TTL support.
    await database.collection("adminSessions").deleteMany({expiresAt: {$lte: new Date()}})
    await database.collection("adminLogins").deleteMany({expiresAt: {$lte: new Date()}})
})
