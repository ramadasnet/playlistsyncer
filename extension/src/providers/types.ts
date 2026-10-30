// Common interface implemented by each provider that the extension can operate on.
import type {ExtensionCommandMap, ExtensionCommandMethod, ExtensionCommandResult, ExtensionProvider, ExtensionProviderAccount} from "../../../shared/types/extension"

export type ProviderErrorCode = NonNullable<ExtensionCommandResult["error"]>["code"]

// Error carrying the result code sent back to the server.
export class ProviderError extends Error {
    code: ProviderErrorCode

    // Create an error with a result code, "failed" by default.
    constructor(message: string, code: ProviderErrorCode = "failed") {
        super(message)
        this.code = code
    }
}

// One method per command, taking the command args and returning its result.
export type ProviderCommands = {[M in ExtensionCommandMethod]: (args: ExtensionCommandMap[M]["args"]) => Promise<ExtensionCommandMap[M]["result"]>}

export interface ProviderConnector extends ProviderCommands {
    provider: ExtensionProvider
    // Display name shown in the popup.
    name: string
    // Page opened in an active tab when the user must sign in.
    loginUrl: string
    // Match patterns of the provider web app tabs.
    tabPatterns: string[]
    // Returns the signed-in account, or null when signed out.
    detectAccount(): Promise<ExtensionProviderAccount | null>
}
