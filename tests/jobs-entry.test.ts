// PM2's Bun container loads the jobs entry with require(), which rejects top-level await.
import {spawnSync} from "node:child_process"
import {describe, expect, test} from "bun:test"

const root = new URL("..", import.meta.url)

describe("jobs process entry", () => {
    test("loads under require() the way PM2 starts it", () => {
        const result = spawnSync("bun", ["-e", "require('./server/jobs/main.ts')"], {
            cwd: root,
            env: {
                ...process.env,
                NODE_ENV: "development",
                // A refused port keeps the startup await pending, which is when Bun rejects require() of this module.
                PLS_MONGODB_URI: "mongodb://127.0.0.1:1/playlistsyncer",
                PLS_INFISICAL_CLIENT_ID: "",
                PLS_INFISICAL_CLIENT_SECRET: "",
                PLS_JSON_LOGGING: "false"
            },
            encoding: "utf8",
            timeout: 15000
        })
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
        expect(output).not.toContain("require() async module")
        expect(output).toContain("ECONNREFUSED")
        expect(result.status).toBe(1)
    }, 20000)
})
