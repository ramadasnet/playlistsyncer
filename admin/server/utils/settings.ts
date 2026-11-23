import {createError, type H3Event} from "h3"
import {runtimeInfisicalConnection} from "../../../server/utils/infisical"
import {InvalidRuntimeSettings, mergeRuntimeSettings, readRuntimeSettings, settingGroups, settingsUpdateSchema, StaleRuntimeSettings, updateRuntimeSettings} from "../../../server/utils/runtime-settings"
import {audited} from "./management"

/** Show effective non-secret values and whether write-only fields are configured. */
function settingsView({revision, values}: Awaited<ReturnType<typeof readRuntimeSettings>>) {
    const config = mergeRuntimeSettings(values)
    return {
        revision,
        groups: settingGroups.map(({label, fields}) => ({
            label,
            fields: Object.entries(fields).map(([key, field]) => {
                const name = key as keyof typeof values
                const effective = config[name]
                const secret = "secret" in field && field.secret
                return {
                    name,
                    label: field.label,
                    hint: "hint" in field ? field.hint : undefined,
                    secret,
                    configured: Array.isArray(effective) ? effective.length > 0 : effective !== undefined,
                    stored: Object.hasOwn(values, name),
                    value: secret ? null : Array.isArray(effective) ? effective.join(", ") : String(effective ?? "")
                }
            })
        }))
    }
}

function assertSettingsAvailable() {
    if (!runtimeInfisicalConnection()) throw createError({statusCode: 503, statusMessage: "Infisical is not configured"})
}

export async function getSettings() {
    assertSettingsAvailable()
    return settingsView(await readRuntimeSettings())
}

export async function patchSettings(event: H3Event, input: unknown) {
    assertSettingsAvailable()
    const parsed = settingsUpdateSchema.safeParse(input)
    if (!parsed.success) throw createError({statusCode: 400, statusMessage: "Invalid application settings update"})
    const update = parsed.data
    try {
        return await audited(event, "settings.update", "application", {fields: Object.keys(update.changes)}, async () => settingsView(await updateRuntimeSettings(update)))
    } catch (error) {
        if (error instanceof StaleRuntimeSettings) throw createError({statusCode: 409, statusMessage: "Settings changed since you opened the editor. Reload and try again."})
        if (error instanceof InvalidRuntimeSettings) throw createError({statusCode: 400, statusMessage: `Invalid setting: ${error.fields.join(", ")}`})
        throw error
    }
}
