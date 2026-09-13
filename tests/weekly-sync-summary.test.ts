import {describe, expect, test} from "bun:test"
import {ObjectId} from "mongodb"
import type {CanonicalTrack, SyncRunDocument, SyncSnapshotDocument, SyncTaskDocument, UserDocument} from "../shared/types/domain"
import type {OutboundEmail} from "../server/domain/mail/send"
import {
    buildWeeklySyncSummaryEmail,
    evaluateWeeklySyncSummaryPreference,
    formatTrackLabel,
    isWeeklySyncSummaryDue,
    playlistNameForChange,
    sendDueWeeklySyncSummaries,
    summarizeSyncChanges,
    weeklySyncSummaryHasChanges,
    weeklySyncSummaryIntervalMs,
    weeklySummaryWindowStart,
    type WeeklySummaryStore
} from "../server/domain/mail/weekly-sync-summary"

const now = new Date("2026-09-11T12:00:00.000Z")
const userId = new ObjectId()
const accountId = new ObjectId()
const taskId = new ObjectId()

function playlistRef(playlistId: string, name: string) {
    return {providerAccountId: accountId, playlistId, name}
}

function task(overrides: Partial<SyncTaskDocument> = {}): SyncTaskDocument {
    return {
        _id: taskId,
        userId,
        mode: "playlist",
        direction: "two-way",
        source: playlistRef("src-1", "Favorites"),
        destination: playlistRef("dst-1", "Favorites copy"),
        status: "active",
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides
    }
}

function track(playlistId: string, providerTrackId: string, extras: {title?: string; artists?: string[]; providerItemId?: string; playlistName?: string} = {}) {
    return {
        providerAccountId: accountId,
        playlistId,
        providerTrackId,
        providerItemId: extras.providerItemId ?? `${providerTrackId}-item`,
        title: extras.title,
        artists: extras.artists,
        playlistName: extras.playlistName
    }
}

function run(overrides: Partial<SyncRunDocument> = {}): SyncRunDocument {
    return {
        _id: new ObjectId(),
        taskId,
        trigger: "scheduled",
        status: "succeeded",
        additions: 0,
        removals: 0,
        conflicts: 0,
        skipped: 0,
        addedTracks: [],
        removedTracks: [],
        startedAt: now,
        finishedAt: now,
        ...overrides
    }
}

function canonical(providerTrackId: string, title: string, artists: string[]): CanonicalTrack {
    return {
        occurrenceId: `${providerTrackId}-item`,
        canonicalKey: `isrc:${providerTrackId}`,
        title,
        artists,
        providerItemId: `${providerTrackId}-item`,
        providerTrackId
    }
}

function snapshot(items: CanonicalTrack[]): SyncSnapshotDocument {
    return {
        _id: new ObjectId(),
        taskId,
        sourceItems: items,
        destinationItems: items,
        createdAt: now
    }
}

function user(overrides: Partial<UserDocument> = {}): UserDocument {
    return {
        _id: userId,
        email: "pro@example.com",
        displayName: "Alex",
        tier: "pro",
        weeklySyncSummaryEnabled: true,
        createdAt: now,
        updatedAt: now,
        ...overrides
    }
}

function memoryStore(input: {users?: UserDocument[]; tasks?: SyncTaskDocument[]; runs?: SyncRunDocument[]; snapshots?: SyncSnapshotDocument[]}): WeeklySummaryStore & {processedAt?: Date; disabled: ObjectId[]; released: ObjectId[]} {
    const queue = [...(input.users || [])]
    const store: WeeklySummaryStore & {processedAt?: Date; disabled: ObjectId[]; released: ObjectId[]} = {
        disabled: [],
        released: [],
        async claimDueUser() {
            return queue.shift() ?? null
        },
        async findTasks() {
            return input.tasks || []
        },
        async findRuns() {
            return input.runs || []
        },
        async findSnapshots() {
            return input.snapshots || []
        },
        async markProcessed(_userId, processedAt) {
            store.processedAt = processedAt
        },
        async disablePreference(userId) {
            store.disabled.push(userId)
        },
        async releaseClaim(userId) {
            store.released.push(userId)
        }
    }
    return store
}

describe("weekly sync summary preference", () => {
    test("rejects Free accounts", () => {
        expect(evaluateWeeklySyncSummaryPreference({tier: "free", email: "free@example.com", enabled: true})).toEqual({
            ok: false,
            statusCode: 403,
            statusMessage: "Weekly sync summaries require a PRO account"
        })
    })

    test("requires a confirmed email before enabling", () => {
        expect(evaluateWeeklySyncSummaryPreference({tier: "pro", enabled: true})).toEqual({
            ok: false,
            statusCode: 400,
            statusMessage: "Confirm an email address before enabling weekly sync summaries"
        })
    })

    test("allows PRO users with an email to opt in or out", () => {
        expect(evaluateWeeklySyncSummaryPreference({tier: "pro", email: "pro@example.com", enabled: true})).toEqual({
            ok: true
        })
        expect(evaluateWeeklySyncSummaryPreference({tier: "pro", email: "pro@example.com", enabled: false})).toEqual({
            ok: true
        })
    })
})

describe("weekly sync summary cadence", () => {
    test("is due when the preference is on and no summary has been sent", () => {
        expect(isWeeklySyncSummaryDue({weeklySyncSummaryEnabled: true, email: "pro@example.com"}, now)).toBe(true)
    })

    test("is not due until a week after the last send", () => {
        expect(
            isWeeklySyncSummaryDue(
                {
                    weeklySyncSummaryEnabled: true,
                    email: "pro@example.com",
                    weeklySyncSummarySentAt: new Date(now.getTime() - weeklySyncSummaryIntervalMs + 1)
                },
                now
            )
        ).toBe(false)
        expect(
            isWeeklySyncSummaryDue(
                {
                    weeklySyncSummaryEnabled: true,
                    email: "pro@example.com",
                    weeklySyncSummarySentAt: new Date(now.getTime() - weeklySyncSummaryIntervalMs)
                },
                now
            )
        ).toBe(true)
    })

    test("uses the previous week when no summary has been sent", () => {
        expect(weeklySummaryWindowStart(undefined, now)).toEqual(new Date(now.getTime() - weeklySyncSummaryIntervalMs))
        expect(weeklySummaryWindowStart(now, now)).toEqual(now)
    })
})

describe("weekly sync summary contents", () => {
    test("groups added and removed tracks by playlist name", () => {
        const summary = summarizeSyncChanges(
            [
                run({
                    addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})],
                    removedTracks: [track("src-1", "t2", {title: "Old Song", artists: ["Bea"]})]
                })
            ],
            [task()]
        )

        expect(weeklySyncSummaryHasChanges(summary)).toBe(true)
        expect(summary.playlists).toEqual([
            {
                playlistName: "Favorites",
                addedTracks: [],
                removedTracks: [{title: "Old Song", artists: ["Bea"]}]
            },
            {
                playlistName: "Favorites copy",
                addedTracks: [{title: "New Song", artists: ["Ada"]}],
                removedTracks: []
            }
        ])
    })

    test("falls back to snapshot titles when run records omit them", () => {
        const summary = summarizeSyncChanges([run({addedTracks: [track("dst-1", "snap-1")]})], [task()], [snapshot([canonical("snap-1", "Snapshot Song", ["Cara"])])])

        expect(summary.playlists[0]?.addedTracks).toEqual([{title: "Snapshot Song", artists: ["Cara"]}])
    })

    test("uses account mappings for playlist names", () => {
        expect(
            playlistNameForChange(
                task({
                    mode: "account",
                    playlistMappings: [{sourcePlaylistId: "src-a", destinationPlaylistId: "dst-a", name: "Road trip"}]
                }),
                "dst-a"
            )
        ).toBe("Road trip")
    })

    test("keeps the recorded playlist name after an account mapping is deleted", () => {
        const summary = summarizeSyncChanges(
            [
                run({
                    removedTracks: [track("dst-gone", "t1", {title: "Old Song", artists: ["Bea"], playlistName: "Road trip"})]
                })
            ],
            [task({mode: "account", playlistMappings: []})]
        )

        expect(summary.playlists).toEqual([
            {
                playlistName: "Road trip",
                addedTracks: [],
                removedTracks: [{title: "Old Song", artists: ["Bea"]}]
            }
        ])
    })

    test("ignores in-progress runs and empty change lists", () => {
        expect(weeklySyncSummaryHasChanges(summarizeSyncChanges([run({status: "running", addedTracks: [track("dst-1", "t1", {title: "Hidden", artists: []})]})], [task()]))).toBe(false)
        expect(weeklySyncSummaryHasChanges(summarizeSyncChanges([run()], [task()]))).toBe(false)
    })

    test("formats artists in the track label", () => {
        expect(formatTrackLabel({title: "Pulse", artists: ["Ada", "Bea"]})).toBe("Pulse — Ada, Bea")
        expect(formatTrackLabel({title: "Pulse", artists: []})).toBe("Pulse")
    })
})

describe("weekly sync summary email", () => {
    test("lists playlists and track changes, and skips sending when nothing changed", async () => {
        const summary = summarizeSyncChanges(
            [
                run({
                    addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})],
                    removedTracks: [track("dst-1", "t2", {title: "<Removed>", artists: ["Bea"]})]
                })
            ],
            [task()]
        )
        const message = buildWeeklySyncSummaryEmail({
            to: "pro@example.com",
            displayName: "Alex",
            summary,
            appUrl: "http://localhost:3007"
        })

        expect(message.subject).toBe("Your PlaylistSyncer weekly sync summary")
        expect(message.text).toContain("Favorites copy")
        expect(message.text).toContain("- New Song — Ada")
        expect(message.text).toContain("- <Removed> — Bea")
        expect(message.html).toContain("New Song — Ada")
        expect(message.html).toContain("&lt;Removed&gt; — Bea")
        expect(message.html).not.toContain("<Removed>")

        const sent: OutboundEmail[] = []
        const withChanges = memoryStore({
            users: [user()],
            tasks: [task()],
            runs: [
                run({
                    addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})]
                })
            ]
        })
        const withoutChanges = memoryStore({
            users: [user({_id: new ObjectId()})],
            tasks: [task()],
            runs: [run()]
        })

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store: withChanges,
                resolveTier: () => "pro",
                send: async (outbound) => {
                    sent.push(outbound)
                    return true
                }
            })
        ).toEqual({processed: 1, sent: 1, skipped: 0})
        expect(sent).toHaveLength(1)
        expect(withChanges.processedAt).toEqual(now)

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store: withoutChanges,
                resolveTier: () => "pro",
                send: async () => {
                    throw new Error("should not send")
                }
            })
        ).toEqual({processed: 1, sent: 0, skipped: 1})
        expect(withoutChanges.processedAt).toEqual(now)
    })

    test("does not send for Free accounts even when they have track changes", async () => {
        const proUser = user()
        const store = memoryStore({
            users: [user({_id: new ObjectId(), tier: "free"}), proUser],
            tasks: [task()],
            runs: [run({addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})]})]
        })
        const sent: OutboundEmail[] = []

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store,
                resolveTier: (candidate) => candidate.tier,
                send: async (outbound) => {
                    sent.push(outbound)
                    return true
                }
            })
        ).toEqual({processed: 2, sent: 1, skipped: 1})
        expect(store.disabled).toHaveLength(1)
        expect(store.processedAt).toEqual(now)
        expect(sent).toHaveLength(1)
    })

    test("does not let downgraded accounts fill the batch and starve later PRO summaries", async () => {
        const sent: OutboundEmail[] = []
        const store = memoryStore({
            users: [user({_id: new ObjectId(), tier: "free"}), user({_id: new ObjectId(), tier: "free"}), user()],
            tasks: [task()],
            runs: [run({addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})]})]
        })

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                limit: 1,
                store,
                resolveTier: (candidate) => candidate.tier,
                send: async (outbound) => {
                    sent.push(outbound)
                    return true
                }
            })
        ).toEqual({processed: 3, sent: 1, skipped: 2})
        expect(store.disabled).toHaveLength(2)
        expect(sent).toHaveLength(1)
    })

    test("retries later when mail delivery fails", async () => {
        const store = memoryStore({
            users: [user()],
            tasks: [task()],
            runs: [run({addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})]})]
        })

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store,
                resolveTier: () => "pro",
                send: async () => false
            })
        ).toEqual({processed: 1, sent: 0, skipped: 1})
        expect(store.processedAt).toBeUndefined()
        expect(store.released).toHaveLength(1)
    })

    test("claims each due user once so overlapping jobs cannot send twice", async () => {
        const store = memoryStore({
            users: [user()],
            tasks: [task()],
            runs: [run({addedTracks: [track("dst-1", "t1", {title: "New Song", artists: ["Ada"]})]})]
        })
        const sent: OutboundEmail[] = []

        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store,
                resolveTier: () => "pro",
                send: async (outbound) => {
                    sent.push(outbound)
                    return true
                }
            })
        ).toEqual({processed: 1, sent: 1, skipped: 0})
        expect(
            await sendDueWeeklySyncSummaries({
                now,
                store,
                resolveTier: () => "pro",
                send: async () => {
                    throw new Error("should not send")
                }
            })
        ).toEqual({processed: 0, sent: 0, skipped: 0})
        expect(sent).toHaveLength(1)
    })
})
