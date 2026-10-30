// Receive the outcomes of provider commands that the browser extension ran.
import {z} from "zod"
import type {ExtensionCommandResult} from "~~/shared/types/extension"
import {submitExtensionResults} from "../../domain/extension/bridge"
import {requireExtensionClient} from "../../domain/extension/clients"

const resultsSchema = z.object({
    results: z
        .array(
            z.object({
                id: z.string().min(1).max(100),
                ok: z.boolean(),
                result: z.unknown().optional(),
                error: z.object({message: z.string().max(2000), code: z.enum(["auth", "rate_limit", "not_found", "unsupported", "failed"]).optional()}).optional()
            })
        )
        .max(100)
})

export default defineEventHandler(async (event) => {
    const {client} = await requireExtensionClient(event)
    const body = resultsSchema.parse(await readBody(event))
    return {accepted: submitExtensionResults(client._id!.toHexString(), body.results as ExtensionCommandResult[])}
})
