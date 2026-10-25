// Ask Apple for Apple Music access with MusicKit JS and save the user token on the server.
const musicKitScriptUrl = "https://js-cdn.music.apple.com/musickit/v3/musickit.js"
// MusicKit addresses its consent window by this name, so the login click can open it before Sign in with Apple returns.
const appleMusicWindowName = "apple-music-service-view"
const appleMusicWindowKey = "playlistsyncer.appleMusicWindow"
const appleMusicWindowFeatures = "width=650,height=650,menubar=no,resizable=no,scrollbars=no,status=no,toolbar=no"
const blockedMusicWindowMessage = "Apple Music access could not be opened. Choose Authorize to allow it."

interface MusicKitInstance {
    authorize(): Promise<string | undefined>
}

interface MusicKitGlobal {
    configure(options: {developerToken: string; app: {name: string; build: string}}): Promise<MusicKitInstance>
}

type MusicKitWindow = Window & {MusicKit?: MusicKitGlobal}

let musicKitLoading: Promise<MusicKitGlobal> | undefined
let instanceLoading: Promise<MusicKitInstance> | undefined
let appleMusicLoginContinuation: Promise<void> | undefined

function loadMusicKit(): Promise<MusicKitGlobal> {
    const loaded = (window as MusicKitWindow).MusicKit
    if (loaded) {
        return Promise.resolve(loaded)
    }
    musicKitLoading ??= new Promise<MusicKitGlobal>((resolve, reject) => {
        document.addEventListener("musickitloaded", () => resolve((window as MusicKitWindow).MusicKit!), {once: true})
        const script = document.createElement("script")
        script.src = musicKitScriptUrl
        script.async = true
        script.onerror = () => {
            musicKitLoading = undefined
            script.remove()
            reject(new Error("Apple MusicKit could not be loaded"))
        }
        document.head.appendChild(script)
    })
    return musicKitLoading
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function readAppleMusicWindowStamp(): number {
    try {
        const stamp = Number(localStorage.getItem(appleMusicWindowKey) || 0)
        return Number.isFinite(stamp) ? stamp : 0
    } catch {
        return 0
    }
}

// The login click's window is still the holding page while its heartbeat is fresh.
export function appleMusicWindowIsWaiting(): boolean {
    const stamp = readAppleMusicWindowStamp()
    return stamp > 0 && Date.now() - stamp < 1500
}

// One return from Sign in with Apple should open MusicKit once, even if the account page mounts twice.
export function runAppleMusicLoginContinuation(run: () => Promise<void>): void {
    if (appleMusicLoginContinuation) {
        return
    }
    appleMusicLoginContinuation = run().finally(() => {
        appleMusicLoginContinuation = undefined
    })
}

// Give the holding page a moment to report itself after Sign in with Apple returns.
export async function waitForAppleMusicWindow(waitMs = 1600): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < waitMs) {
        if (appleMusicWindowIsWaiting()) {
            return true
        }
        await delay(80)
    }
    return appleMusicWindowIsWaiting()
}

// Open MusicKit's window in the login click, then continue to Sign in with Apple in this tab.
export function beginAppleProviderLogin(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
    }
    const anchor = event.currentTarget
    if (!(anchor instanceof HTMLAnchorElement)) {
        return
    }
    const popup = window.open("/apple-music-pending.html", appleMusicWindowName, appleMusicWindowFeatures)
    if (!popup) {
        return
    }
    event.preventDefault()
    // Let the browser keep the popup before this tab leaves for Sign in with Apple.
    window.setTimeout(() => window.location.assign(anchor.href), 50)
}

// Close the holding window when this sign-in already has Apple Music access.
export function closeReservedAppleMusicWindow(): void {
    if (!readAppleMusicWindowStamp()) {
        return
    }
    try {
        localStorage.removeItem(appleMusicWindowKey)
    } catch {
        // Closing the window still matters when storage is blocked.
    }
    const popup = window.open("", appleMusicWindowName)
    if (!popup) {
        return
    }
    try {
        const holdingPage = popup.location.pathname === "/apple-music-pending.html" || popup.location.href === "about:blank"
        if (!holdingPage) {
            return
        }
    } catch {
        return
    }
    popup.close()
}

// Notice when MusicKit cannot reuse the login window, so a blocked popup does not wait forever.
function watchForBlockedMusicWindow(): {failed: () => boolean; restore: () => void} {
    const original = window.open.bind(window)
    let blocked = false
    window.open = ((url?: string | URL, target?: string, features?: string) => {
        const opened = original(url, target, features)
        if (target === appleMusicWindowName && !opened) {
            blocked = true
        }
        return opened
    }) as typeof window.open
    return {
        failed: () => blocked,
        restore: () => {
            window.open = original
        }
    }
}

export function useAppleMusicAuthorization() {
    const runtimeConfig = useRuntimeConfig()
    const authorizing = ref(false)

    // Load and configure MusicKit ahead of the click, so Apple's popup opens within the user's gesture.
    function prepareAppleMusic(): Promise<MusicKitInstance> {
        instanceLoading ??= Promise.all([api<{developerToken: string}>("/api/apple-music/developer-token"), loadMusicKit()])
            .then(([{developerToken}, musicKit]) => musicKit.configure({developerToken, app: {name: String(runtimeConfig.public.appName || "PlaylistSyncer"), build: "1"}}))
            .catch((error) => {
                instanceLoading = undefined
                throw error
            })
        return instanceLoading
    }

    async function authorizeAppleMusic(): Promise<void> {
        authorizing.value = true
        const reservedAtStart = appleMusicWindowIsWaiting()
        let guard: ReturnType<typeof watchForBlockedMusicWindow> | undefined
        let watching: ReturnType<typeof setInterval> | undefined
        try {
            const instance = await prepareAppleMusic()
            if (reservedAtStart && !appleMusicWindowIsWaiting()) {
                throw new Error(blockedMusicWindowMessage)
            }
            guard = appleMusicWindowIsWaiting() ? watchForBlockedMusicWindow() : undefined
            const authorization = instance.authorize()
            const blocked = guard
                ? new Promise<never>((_resolve, reject) => {
                      watching = setInterval(() => {
                          if (guard?.failed()) {
                              reject(new Error(blockedMusicWindowMessage))
                          }
                      }, 100)
                  })
                : undefined
            blocked?.catch(() => {
                // Promise.race handles this rejection when it wins.
            })
            const musicUserToken = await (blocked ? Promise.race([authorization, blocked]) : authorization)
            if (!musicUserToken) {
                throw new Error("Apple Music access was not granted")
            }
            await api("/api/apple-music/authorization", {method: "POST", body: {musicUserToken}})
        } finally {
            if (watching) {
                clearInterval(watching)
            }
            guard?.restore()
            authorizing.value = false
        }
    }

    return {authorizing, prepareAppleMusic, authorizeAppleMusic}
}
