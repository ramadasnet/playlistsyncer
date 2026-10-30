// List the browsers where the user linked the PlaylistSyncer extension.
import {collections} from "../../../data/collections"
import {requireUser} from "../../../domain/auth/session"
import {isExtensionClientOnline} from "../../../domain/extension/bridge"
import {isExtensionEnabled} from "../../../domain/extension/clients"

export default defineEventHandler(async (event) => {
    const user = await requireUser(event)
    if (!isExtensionEnabled()) {
        return {enabled: false, clients: []}
    }
    const db = await collections()
    const clients = await db.extensionClients.find({userId: user._id!}).sort({createdAt: 1}).toArray()
    return {
        enabled: true,
        clients: clients.map((client) => ({
            id: client._id!.toHexString(),
            browser: client.browser,
            version: client.version,
            online: isExtensionClientOnline(client._id!.toHexString()),
            lastSeenAt: client.lastSeenAt,
            createdAt: client.createdAt
        }))
    }
})
