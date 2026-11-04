// Revoke the calling extension's token when the user signs out in the extension.
import {requireExtensionClient, revokeExtensionClient} from "../../domain/extension/clients"

export default defineEventHandler(async (event) => {
    const {client} = await requireExtensionClient(event)
    await revokeExtensionClient(client.userId, client._id!)
    return {ok: true}
})
