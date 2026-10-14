import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {loadInfisicalSecrets} from "../server/utils/infisical"

const settings = {PLS_INFISICAL_CLIENT_ID: "client-id", PLS_INFISICAL_CLIENT_SECRET: "client-secret", PLS_INFISICAL_PROJECT_ID: "project-id"}

function secret(secretKey: string, secretValue: string) {
    return {secretKey, secretValue}
}

describe("Infisical secrets", () => {
    let fetchSpy: ReturnType<typeof spyOn>

    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"))
    })

    afterEach(() => {
        fetchSpy.mockRestore()
    })

    test("does nothing without a client ID", async () => {
        expect(await loadInfisicalSecrets({PLS_INFISICAL_PROJECT_ID: "project-id"})).toEqual([])
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test("requires the client secret and project ID", async () => {
        await expect(loadInfisicalSecrets({PLS_INFISICAL_CLIENT_ID: "client-id", PLS_INFISICAL_PROJECT_ID: "project-id"})).rejects.toThrow("PLS_INFISICAL_CLIENT_SECRET")
        await expect(loadInfisicalSecrets({PLS_INFISICAL_CLIENT_ID: "client-id", PLS_INFISICAL_CLIENT_SECRET: "client-secret"})).rejects.toThrow("PLS_INFISICAL_PROJECT_ID")
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    test("sets missing variables and keeps values that are already set", async () => {
        fetchSpy.mockResolvedValueOnce(Response.json({accessToken: "access-token"}))
        fetchSpy.mockResolvedValueOnce(
            Response.json({
                secrets: [secret("PLS_SESSION_SECRET", "direct"), secret("PLS_MONGODB_URI", "mongodb://infisical"), secret("PLS_SMTP_HOST", "smtp.example.com")],
                imports: [{secrets: [secret("PLS_SESSION_SECRET", "imported"), secret("PLS_SCHEDULER_SECRET", "imported")]}]
            })
        )
        const env: Record<string, string | undefined> = {...settings, PLS_INFISICAL_ENVIRONMENT: "staging", PLS_MONGODB_URI: "mongodb://local", PLS_SMTP_HOST: ""}

        expect(await loadInfisicalSecrets(env)).toEqual(["PLS_SESSION_SECRET", "PLS_SCHEDULER_SECRET", "PLS_SMTP_HOST"])

        expect(env.PLS_SESSION_SECRET).toBe("direct")
        expect(env.PLS_SCHEDULER_SECRET).toBe("imported")
        expect(env.PLS_MONGODB_URI).toBe("mongodb://local")
        expect(env.PLS_SMTP_HOST).toBe("smtp.example.com")
        expect(env.PLS_INFISICAL_CLIENT_SECRET).toBeUndefined()

        const [loginUrl, loginInit] = fetchSpy.mock.calls[0]!
        expect(String(loginUrl)).toBe("https://app.infisical.com/api/v1/auth/universal-auth/login")
        expect(JSON.parse(String(loginInit?.body))).toEqual({clientId: "client-id", clientSecret: "client-secret"})
        const [secretsUrl, secretsInit] = fetchSpy.mock.calls[1]!
        const url = new URL(String(secretsUrl))
        expect(url.pathname).toBe("/api/v4/secrets")
        expect(Object.fromEntries(url.searchParams)).toEqual({projectId: "project-id", environment: "staging", secretPath: "/"})
        expect(new Headers(secretsInit?.headers).get("Authorization")).toBe("Bearer access-token")
    })

    test("fails when Infisical rejects the request", async () => {
        fetchSpy.mockResolvedValueOnce(new Response("Invalid credentials", {status: 401}))

        await expect(loadInfisicalSecrets({...settings})).rejects.toThrow("Infisical login failed: 401 Invalid credentials")
    })
})
