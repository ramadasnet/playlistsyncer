// Long poll from the browser extension: register its provider sessions and hand it queued provider commands.
import {z} from "zod"
import {extensionProviders, type ExtensionPollResponse} from "~~/shared/types/extension"
import {registerExtensionPoll, takeExtensionCommands} from "../../domain/extension/bridge"
import {requireExtensionClient, runDueExtensionTasks, touchExtensionClient, upsertExtensionAccounts} from "../../domain/extension/clients"

const pollSchema = z.object({
    version: z.string().max(40),
    browser: z.enum(["chrome", "firefox"]),
    accounts: z
        .array(
            z.object({
                provider: z.enum(extensionProviders),
                accountId: z.string().min(1).max(200),
                displayName: z.string().max(200),
                imageUrl: z.string().url().max(1000).optional(),
                region: z.string().max(10).optional()
            })
        )
        .max(10)
})

export default defineEventHandler(async (event): Promise<ExtensionPollResponse> => {
    const {client} = await requireExtensionClient(event)
    const body = pollSchema.parse(await readBody(event))
    const clientId = client._id!.toHexString()
    registerExtensionPoll(clientId, client.userId.toHexString(), body.accounts)
    await Promise.all([touchExtensionClient(client, body.version), upsertExtensionAccounts(client.userId, body.accounts)])
    runDueExtensionTasks(client.userId)
    const abort = new AbortController()
    event.node.req.once("close", () => abort.abort())
    return {commands: await takeExtensionCommands(clientId, abort.signal)}
})
