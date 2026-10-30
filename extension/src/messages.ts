// Messages exchanged between the popup and the background script.
import type {ExtensionMeResponse, ExtensionProvider, ExtensionProviderAccount} from "../../shared/types/extension"

export type PopupMessage = {type: "state"; refresh?: boolean} | {type: "connect"} | {type: "disconnect"}

export interface PopupProvider {
    provider: ExtensionProvider
    name: string
    loginUrl: string
    account?: ExtensionProviderAccount
    error?: string
}

export interface PopupState {
    linked: boolean
    user?: ExtensionMeResponse["user"]
    providers: PopupProvider[]
    tasks?: ExtensionMeResponse["tasks"]
    running: number
    serverUrl: string
    redirectUri: string
    error?: string
}
