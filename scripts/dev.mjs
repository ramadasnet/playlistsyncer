const commands = [
    {
        name: "website",
        command: ["bun", "--preload", "./server/preload.ts", "./node_modules/.bin/nuxt", "dev", "--no-fork", "--host", "0.0.0.0", "--port", "3007"]
    },
    {
        name: "admin",
        command: ["bun", "--preload", "./server/preload.ts", "./node_modules/.bin/nuxt", "dev", "admin", "--no-fork", "--host", "127.0.0.1", "--port", "3009"]
    },
    {
        name: "cloudflared",
        command: ["cloudflared", "tunnel", "--config", ".cloudflared/config.yml", "run"]
    }
].filter((entry) => entry.name === "cloudflared" || entry.name === (process.argv.includes("--admin") ? "admin" : "website"))

const children = []
let stopping = false
let receivedSignal

function stopChildren(signal = "SIGTERM") {
    if (stopping) return
    stopping = true
    for (const child of children) child.process.kill(signal)
}

for (const entry of commands) {
    try {
        console.log(`[dev] Starting ${entry.name}`)
        children.push({name: entry.name, process: Bun.spawn(entry.command, {stdin: "inherit", stdout: "inherit", stderr: "inherit"})})
    } catch (error) {
        console.error(`[dev] Could not start ${entry.name}:`, error)
        stopChildren()
        process.exitCode = 1
        break
    }
}

process.once("SIGINT", () => {
    receivedSignal = "SIGINT"
    stopChildren()
})
process.once("SIGTERM", () => {
    receivedSignal = "SIGTERM"
    stopChildren()
})

if (children.length) {
    const firstExit = await Promise.race(children.map(async (child) => ({child, code: await child.process.exited})))
    if (!stopping) {
        console.error(`[dev] ${firstExit.child.name} exited with code ${firstExit.code}; stopping remaining services`)
        stopChildren()
    }
    await Promise.all(children.map((child) => child.process.exited))
    process.exitCode = receivedSignal ? (receivedSignal === "SIGINT" ? 130 : 143) : firstExit.code || 1
}
