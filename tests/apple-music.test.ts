import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {createHash, generateKeyPairSync, verify} from "node:crypto"
import type {H3Event} from "h3"
import * as h3 from "h3"
import {ObjectId} from "mongodb"
import type {ProviderAccountDocument} from "../shared/types/domain"
import * as appleAuth from "../server/domain/auth/apple"
import {finishOAuth} from "../server/domain/auth/oauth"
import {hashOpaqueToken} from "../server/domain/auth/session"
import * as session from "../server/domain/auth/session"
import * as collectionsModule from "../server/data/collections"
import * as http from "../server/domain/providers/http"
import {appleAdapter} from "../server/domain/providers/apple"
import {fetchRetryDefaults} from "../server/utils/fetch-retry"
import {ProviderRateLimiter, providerRateLimiters} from "../server/domain/providers/rate-limit"
import {isProviderEnabled} from "../server/utils/provider-availability"
import {clearServerConfigCache, parseServerConfig} from "../server/utils/config"
import {encryptSecret} from "../server/utils/secrets"

;(globalThis as {createError?: (input: {statusCode: number; statusMessage: string}) => Error}).createError = (input) => Object.assign(new Error(input.statusMessage), input)

const {privateKey, publicKey} = generateKeyPairSync("ec", {namedCurve: "P-256"})
const privateKeyPem = privateKey.export({type: "pkcs8", format: "pem"}).toString()

function decodePart(token: string, index: number) {
    return JSON.parse(Buffer.from(token.split(".")[index]!, "base64url").toString("utf8"))
}

function idToken(claims: Record<string, unknown>) {
    return `${Buffer.from(JSON.stringify({alg: "RS256"})).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

describe("Apple tokens", () => {
    test("signs ES256 JWTs that verify with the public key", () => {
        const token = appleAuth.signAppleJwt("KEY123", privateKeyPem, {iss: "TEAM", iat: 1})
        const [header, payload, signature] = token.split(".")

        expect(decodePart(token, 0)).toEqual({alg: "ES256", kid: "KEY123"})
        expect(decodePart(token, 1)).toEqual({iss: "TEAM", iat: 1})
        expect(verify("sha256", Buffer.from(`${header}.${payload}`), {key: publicKey, dsaEncoding: "ieee-p1363"}, Buffer.from(signature!, "base64url"))).toBe(true)
    })

    test("reads a valid ID token and requires its issuer, audience, expiry, and nonce", () => {
        const now = 1_700_000_000_000
        const claims = {iss: "https://appleid.apple.com", aud: "com.example.web", sub: "001.abc", exp: now / 1000 + 600, nonce: "n1", email: "x@privaterelay.appleid.com", email_verified: "true"}
        const expected = {clientId: "com.example.web", nonce: "n1"}

        expect(appleAuth.readAppleIdToken(idToken(claims), expected, now)).toEqual({sub: "001.abc", email: "x@privaterelay.appleid.com", emailVerified: true})
        expect(() => appleAuth.readAppleIdToken(idToken({...claims, nonce: "other"}), expected, now)).toThrow("Apple returned an invalid ID token")
        expect(() => appleAuth.readAppleIdToken(idToken({...claims, aud: "other"}), expected, now)).toThrow("Apple returned an invalid ID token")
        expect(() => appleAuth.readAppleIdToken(idToken({...claims, iss: "https://evil.example"}), expected, now)).toThrow("Apple returned an invalid ID token")
        expect(() => appleAuth.readAppleIdToken(idToken({...claims, exp: now / 1000 - 1}), expected, now)).toThrow("Apple returned an invalid ID token")
        expect(() => appleAuth.readAppleIdToken("not-a-token", expected, now)).toThrow("Apple returned an invalid ID token")
    })

    test("treats an email without verification as unverified", () => {
        const now = 1_700_000_000_000
        const claims = {iss: "https://appleid.apple.com", aud: "id", sub: "s", exp: now / 1000 + 60, email: "a@example.com"}
        expect(appleAuth.readAppleIdToken(idToken(claims), {clientId: "id"}, now).emailVerified).toBe(false)
    })

    test("is offered only when Sign in with Apple is configured with its key", () => {
        const complete = {
            appleTeamId: "TEAM",
            appleClientId: "com.example.web",
            appleSigninKeyId: "SIGNIN",
            appleSigninPrivateKey: privateKeyPem
        }
        expect(isProviderEnabled("apple", parseServerConfig(complete))).toBe(true)
        for (const key of Object.keys(complete)) {
            expect(isProviderEnabled("apple", parseServerConfig({...complete, [key]: undefined}))).toBe(false)
        }
        expect(parseServerConfig({appleSigninPrivateKey: "-----BEGIN-----\\nabc\\n-----END-----"}).appleSigninPrivateKey).toBe("-----BEGIN-----\nabc\n-----END-----")
    })

    test("continues Apple login into MusicKit and normalizes the return path", async () => {
        const names = ["PLS_SESSION_SECRET", "PLS_TOKEN_ENCRYPTION_KEY", "PLS_APPLE_TEAM_ID", "PLS_APPLE_CLIENT_ID", "PLS_APPLE_SIGNIN_KEY_ID", "PLS_APPLE_SIGNIN_PRIVATE_KEY"] as const
        const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
        const globals = globalThis as Record<string, unknown>
        const savedGlobals = {getCookie: globals.getCookie, deleteCookie: globals.deleteCookie, setCookie: globals.setCookie}
        const originalFetch = globalThis.fetch
        Object.assign(globals, {getCookie: h3.getCookie, deleteCookie: h3.deleteCookie, setCookie: h3.setCookie})
        for (const [name, value] of [
            ["PLS_SESSION_SECRET", "apple-login-session"],
            ["PLS_TOKEN_ENCRYPTION_KEY", "apple-login-encryption"],
            ["PLS_APPLE_TEAM_ID", "TEAMID1234"],
            ["PLS_APPLE_CLIENT_ID", "com.example.web"],
            ["PLS_APPLE_SIGNIN_KEY_ID", "SIGNINKEY1"],
            ["PLS_APPLE_SIGNIN_PRIVATE_KEY", privateKeyPem]
        ] as const) {
            process.env[name] = value
        }
        clearServerConfigCache()
        const userId = new ObjectId()
        const user = {_id: userId, email: "listener@example.com", displayName: "Apple Music user", tier: "free" as const, createdAt: new Date(), updatedAt: new Date()}
        const db = {
            oauthTransactions: {findOneAndDelete: async () => undefined as unknown},
            providerAccounts: {
                find: () => ({toArray: async () => []}),
                findOne: async () => null,
                updateOne: async () => ({})
            },
            users: {
                findOne: async (query: {email?: string}) => (query.email ? null : user),
                insertOne: async () => ({insertedId: userId}),
                updateOne: async () => ({})
            }
        }
        const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue(db as never)
        const sessionSpy = spyOn(session, "createSession").mockResolvedValue()
        try {
            const finish = async (redirectAfter: string) => {
                const state = `state-${redirectAfter}`
                const verifier = `verifier-${redirectAfter}`
                db.oauthTransactions.findOneAndDelete = async () => ({
                    redirectAfter,
                    codeVerifier: await encryptSecret(verifier),
                    expiresAt: new Date(Date.now() + 60_000)
                })
                const nonce = createHash("sha256").update(verifier).digest("base64url")
                const claims = {iss: "https://appleid.apple.com", aud: "com.example.web", sub: "001.apple", exp: Date.now() / 1000 + 600, nonce, email: user.email, email_verified: true}
                globalThis.fetch = (async () => new Response(JSON.stringify({access_token: "apple-access", id_token: idToken(claims)}))) as typeof fetch
                const cookie = `ps_oauth_${hashOpaqueToken(state)}=browser-nonce`
                return finishOAuth(oauthEvent(cookie), "apple", "apple-code", state)
            }

            expect(await finish("/sync?page=2")).toBe("/account?appleMusic=authorize&redirect=%2Fsync%3Fpage%3D2")
            expect(await finish("//evil.example")).toBe("/account?appleMusic=authorize&redirect=%2Fsync")
            expect(await finish("https://evil.example/phish")).toBe("/account?appleMusic=authorize&redirect=%2Fsync")
        } finally {
            collectionsSpy.mockRestore()
            sessionSpy.mockRestore()
            globalThis.fetch = originalFetch
            for (const name of names) {
                if (saved[name] === undefined) delete process.env[name]
                else process.env[name] = saved[name]
            }
            clearServerConfigCache()
            Object.assign(globals, savedGlobals)
        }
    })
})

function oauthEvent(cookie: string): H3Event {
    const headers = new Map<string, string | string[]>()
    return {
        node: {
            req: {headers: {cookie}},
            res: {
                getHeader: (name: string) => headers.get(name.toLowerCase()),
                setHeader: (name: string, value: string | string[]) => headers.set(name.toLowerCase(), value),
                removeHeader: (name: string) => headers.delete(name.toLowerCase()),
                appendHeader: (name: string, value: string) => {
                    const current = headers.get(name.toLowerCase())
                    if (!current) headers.set(name.toLowerCase(), value)
                    else headers.set(name.toLowerCase(), Array.isArray(current) ? [...current, value] : [current, value])
                }
            }
        }
    } as unknown as H3Event
}

const providerFetch = mock(async (): Promise<unknown> => undefined)
const account = {provider: "apple", externalAccountId: "001.abc", storefront: "us"} as ProviderAccountDocument
const api = "https://api.music.apple.com/v1"

describe("Apple Music provider", () => {
    const providerFetchSpy = spyOn(http, "providerFetch").mockImplementation(providerFetch as unknown as typeof http.providerFetch)
    afterAll(() => providerFetchSpy.mockRestore())
    beforeEach(() => providerFetch.mockReset())

    test("lists library playlists across pages and keeps only editable ones for writing", async () => {
        providerFetch.mockResolvedValueOnce({
            data: [{id: "p.1", type: "library-playlists", attributes: {name: "Mine", canEdit: true, description: {standard: "Late"}, artwork: {url: "https://img/{w}x{h}.jpg"}}}],
            next: "/v1/me/library/playlists?offset=100"
        })
        providerFetch.mockResolvedValueOnce({data: [{id: "p.2", type: "library-playlists", attributes: {name: "Curated", canEdit: false}}]})

        const playlists = await appleAdapter.listPlaylists(account, {writableOnly: true})

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, `${api}/me/library/playlists?limit=100`)
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, `${api}/me/library/playlists?offset=100&limit=100`)
        expect(playlists).toEqual([{id: "p.1", name: "Mine", description: "Late", imageUrl: "https://img/300x300.jpg"}])
    })

    test("reads playlist songs with catalog ISRCs, keeps library-only songs, and skips music videos", async () => {
        providerFetch.mockResolvedValueOnce({
            data: [
                {
                    id: "p.1",
                    type: "library-playlists",
                    relationships: {
                        tracks: {
                            data: [
                                {id: "i.A", type: "library-songs", attributes: {name: "Song", artistName: "Queen & David Bowie", playParams: {id: "i.A", kind: "song", catalogId: "100"}}},
                                {id: "i.V", type: "library-music-videos", attributes: {name: "Video", artistName: "Band"}},
                                {id: "i.U", type: "library-songs", attributes: {name: "Upload", artistName: "Me, Myself & I", durationInMillis: 1000}}
                            ],
                            next: "/v1/me/library/playlists/p.1/tracks?offset=100"
                        }
                    }
                }
            ]
        })
        providerFetch.mockResolvedValueOnce({data: [{id: "i.A", type: "library-songs", attributes: {name: "Song", artistName: "Queen & David Bowie", playParams: {id: "i.A", kind: "song", catalogId: "100"}}}]})
        providerFetch.mockResolvedValueOnce({
            data: [
                {
                    id: "100",
                    type: "songs",
                    attributes: {name: "Under Pressure", artistName: "Queen & David Bowie", albumName: "Hot Space", durationInMillis: 248000, isrc: "GBUM71029605", url: "https://music.apple.com/us/song/100"},
                    relationships: {
                        artists: {
                            data: [
                                {id: "1", type: "artists", attributes: {name: "Queen"}},
                                {id: "2", type: "artists", attributes: {name: "David Bowie"}}
                            ]
                        }
                    }
                }
            ]
        })

        const tracks = await appleAdapter.getPlaylistItems(account, "p.1")

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, `${api}/me/library/playlists/p.1?include=tracks`)
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, `${api}/me/library/playlists/p.1/tracks?offset=100&limit=100`)
        expect(providerFetch).toHaveBeenNthCalledWith(3, account, `${api}/catalog/us/songs?ids=100&include=artists`)
        expect(tracks).toEqual([
            {
                itemId: "apple:song:100:0",
                trackId: "apple:song:100",
                title: "Under Pressure",
                artists: ["Queen", "David Bowie"],
                album: "Hot Space",
                durationMs: 248000,
                isrc: "GBUM71029605",
                imageUrl: undefined,
                url: "https://music.apple.com/us/song/100"
            },
            {itemId: "apple:library-song:i.U:1", trackId: "apple:library-song:i.U", title: "Upload", artists: ["Me", "Myself", "I"], album: undefined, durationMs: 1000, isrc: undefined, imageUrl: undefined},
            {
                itemId: "apple:song:100:2",
                trackId: "apple:song:100",
                title: "Under Pressure",
                artists: ["Queen", "David Bowie"],
                album: "Hot Space",
                durationMs: 248000,
                isrc: "GBUM71029605",
                imageUrl: undefined,
                url: "https://music.apple.com/us/song/100"
            }
        ])
    })

    test("searches the account's storefront by ISRC, then by title and artist", async () => {
        providerFetch.mockResolvedValueOnce({data: []})
        providerFetch.mockResolvedValueOnce({results: {songs: {data: [{id: "7", type: "songs", attributes: {name: "Blackbird", artistName: "The Beatles", isrc: "GBAYE0601690"}}]}}})

        const match = await appleAdapter.searchTrack(account, {itemId: "x", trackId: "x", title: "Blackbird", artists: ["The Beatles"], isrc: "GBAYE0601999"})

        expect(providerFetch).toHaveBeenNthCalledWith(1, account, `${api}/catalog/us/songs?filter%5Bisrc%5D=GBAYE0601999&include=artists`)
        expect(providerFetch).toHaveBeenNthCalledWith(2, account, `${api}/catalog/us/search?term=The+Beatles+Blackbird&types=songs&limit=10`)
        expect(match?.trackId).toBe("apple:song:7")
    })

    test("appends catalog and library songs, and refuses removals and deletions", async () => {
        await appleAdapter.addTracks(account, "p.1", ["apple:song:1", "spotify:track:x", "apple:library-song:i.U"])

        expect(appleAdapter.appendOnly).toBe(true)
        expect(providerFetch).toHaveBeenCalledWith(account, `${api}/me/library/playlists/p.1/tracks`, {
            method: "POST",
            body: JSON.stringify({
                data: [
                    {id: "1", type: "songs"},
                    {id: "i.U", type: "library-songs"}
                ]
            })
        })
        await expect(appleAdapter.removePlaylistItems(account, "p.1", ["apple:song:1:0"])).rejects.toMatchObject({statusCode: 501})
        await expect(appleAdapter.deletePlaylist(account, "p.1")).rejects.toMatchObject({statusCode: 501})
    })

    test("treats a just-created playlist that Apple does not list yet as empty", async () => {
        providerFetch.mockResolvedValueOnce({data: [{id: "p.new", type: "library-playlists", attributes: {name: "Fresh"}}]})
        const created = await appleAdapter.createPlaylist(account, "Fresh", "From Spotify")
        expect(providerFetch).toHaveBeenLastCalledWith(account, `${api}/me/library/playlists`, {
            method: "POST",
            body: JSON.stringify({attributes: {name: "Fresh", description: "From Spotify", isPublic: false}})
        })
        expect(created).toEqual({id: "p.new", name: "Fresh", description: "", imageUrl: undefined, itemCount: 0})

        const notFound = Object.assign(new Error("apple API request failed (404)"), {statusCode: 502, statusMessage: "apple API request failed (404)"})
        providerFetch.mockRejectedValueOnce(notFound)
        expect(await appleAdapter.getPlaylistItems(account, "p.new")).toEqual([])
        providerFetch.mockRejectedValueOnce(notFound)
        await expect(appleAdapter.getPlaylistItems(account, "p.old")).rejects.toBe(notFound)
    })
})

describe("Apple Music requests", () => {
    const originalFetch = globalThis.fetch
    const originalDefaults = {...fetchRetryDefaults}
    const fetchMock = mock(async (): Promise<Response> => new Response("{}"))
    const developerTokenSpy = spyOn(appleAuth, "appleMusicDeveloperToken").mockImplementation(() => "developer-token")
    const userTokenSpy = spyOn(appleAuth, "appleMusicUserToken").mockImplementation(async () => "music-user-token")

    beforeEach(() => {
        fetchMock.mockReset()
        globalThis.fetch = fetchMock as unknown as typeof fetch
        Object.assign(fetchRetryDefaults, {baseDelayMs: 0, maxDelayMs: 0})
        providerRateLimiters.set("apple", new ProviderRateLimiter("apple", 0, {cooldownMs: 0}))
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
        Object.assign(fetchRetryDefaults, originalDefaults)
        providerRateLimiters.delete("apple")
        developerTokenSpy.mockRestore()
        userTokenSpy.mockRestore()
    })

    test("sends the developer token and the MusicKit user token", async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({data: [{id: "us"}]})))

        await http.providerFetch(account, `${api}/me/storefront`)

        const headers = new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers)
        expect(headers.get("Authorization")).toBe("Bearer developer-token")
        expect(headers.get("Music-User-Token")).toBe("music-user-token")
    })

    test("asks for authorization again when Apple rejects the user token", async () => {
        fetchMock.mockResolvedValue(new Response("", {status: 403}))

        await expect(http.providerFetch(account, `${api}/me/library/playlists`)).rejects.toMatchObject({statusCode: 409, statusMessage: appleAuth.appleMusicAuthorizationMessage})
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("clears a rejected MusicKit token only when it is still the stored one", async () => {
        const rejected = {version: 2, iv: "iv", ciphertext: "rejected"}
        const updates: {filter: unknown; update: {$unset: {musicUserToken: string}; $set: {updatedAt: Date}}}[] = []
        const collectionsSpy = spyOn(collectionsModule, "collections").mockResolvedValue({
            providerAccounts: {
                updateOne: async (filter: unknown, update: {$unset: {musicUserToken: string}; $set: {updatedAt: Date}}) => {
                    updates.push({filter, update})
                    return {matchedCount: 1}
                }
            }
        } as never)
        try {
            fetchMock.mockResolvedValue(new Response("", {status: 403}))
            const revoked = {...account, _id: "account", musicUserToken: rejected} as ProviderAccountDocument
            await expect(http.providerFetch(revoked, `${api}/me/library/playlists`)).rejects.toMatchObject({statusCode: 409, statusMessage: appleAuth.appleMusicAuthorizationMessage})
            expect(updates).toHaveLength(1)
            expect(updates[0]!.filter).toEqual({_id: "account", musicUserToken: rejected})
            expect(updates[0]!.update.$unset).toEqual({musicUserToken: ""})
            expect(updates[0]!.update.$set.updatedAt).toBeInstanceOf(Date)
        } finally {
            collectionsSpy.mockRestore()
        }
    })
})
