// Report process liveness without requiring a database connection.
export default defineEventHandler(() => ({
    status: "ok",
    timestamp: new Date().toISOString()
}))
