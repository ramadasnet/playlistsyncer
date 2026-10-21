// Ask Apple for Apple Music access with MusicKit JS and save the user token on the server.
const musicKitScriptUrl = "https://js-cdn.music.apple.com/musickit/v3/musickit.js"

interface MusicKitInstance {
    authorize(): Promise<string | undefined>
}

interface MusicKitGlobal {
    configure(options: {developerToken: string; app: {name: string; build: string}}): Promise<MusicKitInstance>
}

type MusicKitWindow = Window & {MusicKit?: MusicKitGlobal}

let musicKitLoading: Promise<MusicKitGlobal> | undefined
let instanceLoading: Promise<MusicKitInstance> | undefined

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
        try {
            const musicUserToken = await (await prepareAppleMusic()).authorize()
            if (!musicUserToken) {
                throw new Error("Apple Music access was not granted")
            }
            await api("/api/apple-music/authorization", {method: "POST", body: {musicUserToken}})
        } finally {
            authorizing.value = false
        }
    }

    return {authorizing, prepareAppleMusic, authorizeAppleMusic}
}
