// Builds the Chrome and Firefox extensions into extension/dist. Run with `bun extension/build.ts`.
import {$} from "bun"
import {mkdir, rm} from "node:fs/promises"
import {deflateSync, inflateSync} from "node:zlib"
import pkg from "../package.json"
import {hostPermissions} from "./src/hosts"

type Browser = "chrome" | "firefox"

const root = import.meta.dir
const dist = `${root}/dist`
const serverUrl = (process.env.PLS_EXTENSION_SERVER_URL || "https://playlistsyncer.com").replace(/\/+$/, "")
const iconSizes = [16, 32, 48, 128]
const permissions = ["identity", "storage", "alarms", "tabs", "scripting", "webRequest", "idle"]

if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(pkg.version) || pkg.version.split(".").some((n) => Number(n) > 65535)) throw new Error(`Invalid extension version ${pkg.version}`)

// Decode an 8-bit RGBA, non-interlaced PNG.
function decodePng(data: Uint8Array): {width: number; height: number; pixels: Uint8Array} {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (data[24] !== 8 || data[25] !== 6 || data[28] !== 0) throw new Error("Icon source must be an 8-bit RGBA non-interlaced PNG")
    const idat: Uint8Array[] = []
    for (let offset = 8; offset < data.length;) {
        const length = view.getUint32(offset)
        const type = new TextDecoder().decode(data.subarray(offset + 4, offset + 8))
        if (type === "IDAT") idat.push(data.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
    }
    const raw = inflateSync(Buffer.concat(idat))
    const stride = width * 4
    const pixels = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!
        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]!
            const a = x >= 4 ? pixels[y * stride + x - 4]! : 0
            const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0
            const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0
            const p = a + b - c
            const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
            const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!
            pixels[y * stride + x] = (value + predictor) & 255
        }
    }
    return {width, height, pixels}
}

// Downscale RGBA pixels by averaging (alpha-weighted) the source box of each target pixel.
function resize(src: {width: number; height: number; pixels: Uint8Array}, size: number): Uint8Array {
    const out = new Uint8Array(size * size * 4)
    const scale = src.width / size
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sum = [0, 0, 0, 0]
            let count = 0
            for (let sy = Math.floor(y * scale); sy < Math.floor((y + 1) * scale); sy++) {
                for (let sx = Math.floor(x * scale); sx < Math.floor((x + 1) * scale); sx++) {
                    const i = (sy * src.width + sx) * 4
                    const alpha = src.pixels[i + 3]!
                    for (let ch = 0; ch < 3; ch++) sum[ch]! += src.pixels[i + ch]! * alpha
                    sum[3]! += alpha
                    count++
                }
            }
            const o = (y * size + x) * 4
            for (let ch = 0; ch < 3; ch++) out[o + ch] = sum[3] ? Math.round(sum[ch]! / sum[3]!) : 0
            out[o + 3] = Math.round(sum[3]! / count)
        }
    }
    return out
}

// Encode RGBA pixels as a PNG.
function encodePng(size: number, pixels: Uint8Array): Uint8Array {
    const chunk = (type: string, body: Uint8Array) => {
        const out = new Uint8Array(body.length + 12)
        const view = new DataView(out.buffer)
        view.setUint32(0, body.length)
        out.set(new TextEncoder().encode(type), 4)
        out.set(body, 8)
        view.setUint32(body.length + 8, Bun.hash.crc32(out.subarray(4, body.length + 8)))
        return out
    }
    const header = new Uint8Array(13)
    new DataView(header.buffer).setUint32(0, size)
    new DataView(header.buffer).setUint32(4, size)
    header.set([8, 6, 0, 0, 0], 8)
    const raw = new Uint8Array((size * 4 + 1) * size)
    for (let y = 0; y < size; y++) raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
    return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())])
}

// Manifest of one browser.
function manifest(browser: Browser): Record<string, unknown> {
    const icons = Object.fromEntries(iconSizes.map((size) => [size, `icons/icon-${size}.png`]))
    const base = {
        manifest_version: 3,
        name: "PlaylistSyncer",
        description: "Sync your Spotify and Amazon Music playlists with PlaylistSyncer, using your own browser session.",
        version: pkg.version,
        icons,
        action: {default_popup: "popup.html", default_title: "PlaylistSyncer", default_icon: icons},
        permissions,
        host_permissions: hostPermissions(new URL(serverUrl).origin)
    }
    if (browser === "chrome") return {...base, minimum_chrome_version: "116", background: {service_worker: "background.js", type: "module"}}
    return {...base, background: {scripts: ["background.js"], type: "module"}, browser_specific_settings: {gecko: {id: "extension@playlistsyncer.com", strict_min_version: "128.0", data_collection_permissions: {required: ["websiteContent"]}}}}
}

// Build one browser target.
async function build(browser: Browser, icons: Record<number, Uint8Array>): Promise<void> {
    const outdir = `${dist}/${browser}`
    const result = await Bun.build({
        entrypoints: [`${root}/src/background.ts`, `${root}/src/popup/popup.ts`],
        outdir,
        target: "browser",
        format: "esm",
        naming: "[name].[ext]",
        define: {PLS_EXTENSION_SERVER_URL: JSON.stringify(serverUrl), PLS_BROWSER: JSON.stringify(browser)}
    })
    if (!result.success) throw new AggregateError(result.logs, `Build failed for ${browser}`)
    await Bun.write(`${outdir}/popup.html`, Bun.file(`${root}/src/popup/popup.html`))
    await Bun.write(`${outdir}/popup.css`, Bun.file(`${root}/src/popup/popup.css`))
    for (const size of iconSizes) await Bun.write(`${outdir}/icons/icon-${size}.png`, icons[size]!)
    await Bun.write(`${outdir}/manifest.json`, JSON.stringify(manifest(browser), null, 4) + "\n")
    if (Bun.which("zip")) await $`cd ${outdir} && zip -qr ../playlistsyncer-${browser}.zip .`
    console.log(`Built ${outdir}`)
}

await rm(dist, {recursive: true, force: true})
await mkdir(dist, {recursive: true})
const logo = decodePng(new Uint8Array(await Bun.file(`${root}/../public/logo-mark.png`).arrayBuffer()))
const icons = Object.fromEntries(iconSizes.map((size) => [size, encodePng(size, resize(logo, size))]))
await build("chrome", icons)
await build("firefox", icons)
console.log(`Server URL: ${serverUrl}`)
