// Popup UI: link status, provider sign-in status and the tasks handled by this browser.
import type {PopupMessage, PopupState} from "../messages"

const app = document.getElementById("app")!
const origins = chrome.runtime.getManifest().host_permissions ?? []
let state: PopupState | undefined
let hostAccess = true
let refreshing = true
let connecting = false
let error: string | undefined

// Create an element with attributes ("text" sets the text content) and children.
function el(tag: string, props: Record<string, string> = {}, ...children: (Node | string | false | undefined)[]): HTMLElement {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (key === "text") node.textContent = value
        else node.setAttribute(key, value)
    }
    node.append(...children.filter((child): child is Node | string => !!child))
    return node
}

// Create a button with a click handler.
function button(label: string, onClick: () => void, className = "", disabled = false): HTMLButtonElement {
    const node = el("button", {type: "button", class: className, text: label}) as HTMLButtonElement
    node.disabled = disabled
    node.addEventListener("click", onClick)
    return node
}

// Send a message to the background script and render the returned state.
async function send(message: PopupMessage): Promise<void> {
    try {
        const response = await chrome.runtime.sendMessage(message)
        if (response?.providers) state = response as PopupState
        error = response?.providers ? (state?.error ?? error) : (response?.error ?? "No response from the extension")
    } catch (err) {
        error = err instanceof Error ? err.message : String(err)
    }
    hostAccess = await chrome.permissions.contains({origins})
    render()
}

// Ask for the provider host permissions (Firefox may not grant them at install).
function requestAccess(): void {
    void chrome.permissions.request({origins}).then(() => send({type: "state", refresh: true}))
}

// Start linking; the background script runs the flow, since the popup may close meanwhile.
function connect(): void {
    connecting = true
    error = undefined
    render()
    void send({type: "connect"}).finally(() => {
        connecting = false
        render()
    })
}

// Unlink the extension.
function disconnect(): void {
    error = undefined
    void send({type: "disconnect"})
}

// Render the current state.
function render(): void {
    const nodes: Node[] = []
    if (error) nodes.push(el("p", {class: "error", role: "alert", text: error}))
    if (!state) return app.replaceChildren(...nodes)
    if (!hostAccess) nodes.push(el("p", {text: "PlaylistSyncer needs access to Spotify and Amazon Music to run your syncs."}), button("Allow access", requestAccess, "wide"))

    if (!state.linked) {
        nodes.push(el("p", {text: "Connect this browser to your PlaylistSyncer account to sync Spotify and Amazon Music playlists using your own browser session."}))
        nodes.push(button(connecting ? "Waiting for approval…" : "Connect to PlaylistSyncer", connect, "wide", connecting))
        nodes.push(el("footer", {}, el("p", {class: "muted", text: "Redirect URI"}), el("code", {text: state.redirectUri})))
    } else {
        nodes.push(el("div", {class: "row"}, el("span", {}, "Linked as ", el("strong", {text: state.user?.name ?? "unknown"})), button("Disconnect", disconnect, "secondary")))
        if (state.running) nodes.push(el("p", {class: "busy", role: "status", text: `Running ${state.running} operation${state.running === 1 ? "" : "s"}`}))

        nodes.push(el("h2", {text: "Music services"}))
        const providers = state.providers.map((p) => {
            const status = p.account ? `Signed in as ${p.account.displayName}` : refreshing ? "Checking…" : "Not signed in"
            const signIn = !p.account && !refreshing && button(`Sign in`, () => void chrome.tabs.create({url: p.loginUrl, active: true}))
            if (signIn) signIn.setAttribute("aria-label", `Sign in to ${p.name}`)
            return el("li", {class: "row"}, el("span", {}, el("strong", {text: p.name}), el("small", {text: status}), !refreshing && p.error && !p.account && el("small", {text: p.error})), signIn)
        })
        nodes.push(el("ul", {}, ...providers))

        nodes.push(el("h2", {text: "Tasks"}))
        if (state.tasks?.length) {
            const tasks = state.tasks.map((t) =>
                el("li", {class: "row"}, el("span", {}, t.name, t.lastRunAt && el("small", {text: `Last run ${new Date(t.lastRunAt).toLocaleString()}${t.lastRunStatus ? ` (${t.lastRunStatus})` : ""}`})), el("span", {class: "badge", text: t.status}))
            )
            nodes.push(el("ul", {}, ...tasks))
        } else {
            nodes.push(el("p", {class: "muted", text: state.tasks ? "No tasks use this browser yet." : "Loading tasks…"}))
        }
        nodes.push(el("footer", {}, el("a", {href: state.serverUrl, target: "_blank", rel: "noopener", text: "Open PlaylistSyncer"})))
    }
    app.replaceChildren(...nodes)
    app.setAttribute("aria-busy", String(refreshing))
}

// Show the cached state right away, then refresh accounts and tasks, then keep the running count updated.
async function start(): Promise<void> {
    await send({type: "state"})
    await send({type: "state", refresh: true})
    refreshing = false
    render()
    setInterval(() => void send({type: "state"}), 3000)
}

void start()
