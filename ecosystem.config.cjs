/** @type {import("pm2").StartOptions[]} */

const apps = [
    {
        name: "playlistsyncer",
        cwd: __dirname,
        script: ".output/server/index.mjs",
        interpreter: "bun",
        instances: 1,
        exec_mode: "fork",
        env_file: ".env",
        env: {
            NODE_ENV: "production",
            HOST: "0.0.0.0",
            PORT: "3007",
            PLS_JSON_LOGGING: "true",
            NITRO_BUN_IDLE_TIMEOUT: "255"
        },
        kill_timeout: 10000
    },
    {
        name: "playlistsyncer-jobs",
        cwd: __dirname,
        script: "server/jobs/main.ts",
        interpreter: "bun",
        instances: 1,
        exec_mode: "fork",
        env_file: ".env",
        env: {
            NODE_ENV: "production",
            HOST: "0.0.0.0",
            PLS_JOBS_PORT: "3008",
            PLS_JSON_LOGGING: "true"
        },
        kill_timeout: 10000
    }
]

module.exports = {apps}
