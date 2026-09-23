# PlaylistSyncer (BETA)

An open-source service that allows users to sync their playlists among multiple music providers.

- Two-way sync: changes made to a playlist on one service will also update the playlist on the other service.
- One-way sync: one provider acts as the master, and the playlist on the other provider is a mirror of the master.
- Full sync: all playlists from one provider are synced to the other provider.
- Automatic sync: background jobs will sync the playlists automatically every few hours / days, depending on settings.
  Supported providers: Spotify, YouTube Music, TIDAL.

## Stack

- TypeScript + Nuxt 4 running on Bun
- MongoDB database, also compatible with Google Firestore and Amazon DocumentDB
- Platform agnostic, should run anywhere using Docker
- Creem is used for billing and payments

## Architecture and persistence

MongoDB collections hold:

- users and their effective Free or PRO entitlement
- encrypted provider credentials and provider account identities
- opaque sessions and short-lived OAuth transactions
- synchronization tasks, account-level playlist mappings, leases, and next-run times
- playlist baselines and synchronization run history
- idempotently processed Creem webhook event IDs

Indexes enforce unique users, provider identities, sessions, OAuth states, snapshots, and webhook events. Sessions and OAuth transactions expire automatically.

Sync runs are retained for 180 days and webhook event records for 90 days.

## Synchronization Steps

### Two-way sync

- A change made on only one side is propagated to the other.
- The same change made on both sides is accepted.
- Contradictory changes preserve the larger occurrence count, are recorded as conflicts, and flag the task with `needs_attention`.
- Duplicate track occurrences are counted and preserved where the provider permits them.
- Tracks that cannot be matched in the other provider's catalog are skipped. In this case, users can use the frontend to find and match the track manually.
- Tasks store a snapshot alias between the unmatched song and manually selected tracks, so later syncs keep both copies instead of removing the manual choice.

### One-way sync

- The first selected playlist is always master. Sync tasks will mirror changes made to the second playlist.
- Tracks added or removed from the second playlist are never synced back to the master, and might be overwritten.

### Full sync

- If the user selects `ALL Playlists` as the source, a full sync will consider the first provider the master and the second provider the mirror.
- Each source playlist is matched to its durable destination mapping, then by an unclaimed playlist with the same name, or created as a new playlist if it doesn't exist.
- When a previously mapped source playlist disappears, its mapped destination playlist is not deleted.
- Every execution acquires a 15-minute database lease and records additions, removals, conflicts, skipped tracks, and failures. This prevents overlapping manual and scheduled runs of the same task.

## Plans and scheduling

- Free: one playlist-pair task, weekly scheduled runs, and a 24-hour cooldown between successful manual runs.
- PRO: unlimited playlist-pair and whole-account tasks, scheduled every 12 hours, with no manual-run cooldown. Every account can open the latest run's added, removed, and unmatched tracks. Browsing past runs is a PRO feature. An optional weekly email lists playlists and tracks added or removed, and is sent only when there were changes.
- Complimentary trial: set `PRO_SUBSCRIPTION_REQUIRED_AT` to an ISO 8601 instant. Until that moment, every account has effective PRO access without a subscription and can still start checkout to keep PRO afterward.

Creem webhook events are the source of truth for paid entitlement. Downgrades and the end of the complimentary trial retain tasks and history. Extra playlist-pair tasks and every whole-account task are paused with an entitlement lock: they cannot run or be edited, and the UI explains that a PRO subscription is needed. The earliest playlist-pair task stays enabled on Free. In local development, `DEVELOPMENT_PRO_USER_EMAILS` can grant an explicitly labeled PRO override without creating a subscription.

On startup, legacy whole-account tasks are assigned a provider-pair key to prevent concurrent creation of duplicate full syncs. If existing tasks already share a provider pair, the oldest claims the key and the other tasks are retained but paused with a conflict notice. Delete the duplicate tasks to clear the conflict; they cannot be resumed.

## Authentication and security

OAuth uses Authorization Code with PKCE, hashed single-use state, exact callback URLs, and ten-minute transaction expiry. Automatic registration matches a provider-verified email to an existing account. If the provider does not share a verified email, the user is signed in and sent to the account page to enter an address. That value is stored as a temporary email until the user confirms it from a mailed link; only then is it set on the profile. An already authenticated user may explicitly link another provider account, but only one account per provider. Sessions are opaque, server-stored, and delivered in secure HTTP-only cookies outside development.

Provider tokens are encrypted at rest with versioned AES-GCM values. Access tokens are refreshed 15 minutes before expiry, concurrent refreshes for the same account are coalesced, and a provider 401 retries once after a forced refresh. External HTTP requests (provider APIs and OAuth) go through `server/utils/fetch-retry.ts`, which applies a per-attempt timeout and retries rate limits (429, plus YouTube `rateLimitExceeded` 403s for provider API requests), transient 408/5xx errors, and network failures with jittered exponential backoff when safe to repeat, honoring `Retry-After` up to 30 seconds by default. Non-idempotent requests, including playlist additions, OAuth code exchanges, and token refreshes, retry only rate-limit responses. Creem uses its SDK's own timeout and retry settings. Provider API requests and OAuth profile requests pass through a process-wide limiter per provider (`server/domain/providers/rate-limit.ts`) shared by every account: request starts are spaced to stay under the provider's configured requests per minute, and a rate limit hit by any account pauses and queues every pending request for that provider until `Retry-After` has passed (5 seconds when absent, growing with each consecutive slowdown), then resumes at half pace and recovers one step per idle minute. Provider API requests retry rate limits up to 5 times and honor cooldowns up to 5 minutes; longer cooldowns fail with 429 instead of queueing. The limiter coordinates a single app instance; multiple instances each pace independently. Mutating application requests are restricted to the configured origin, scheduler routes require a constant-time-checked bearer secret, and Creem webhooks require valid signatures and unique event IDs. Secrets, authorization headers, OAuth codes and tokens, raw webhook payloads, and email addresses are excluded from logs.

## Running locally

Prerequisites: Bun 1.4+, Docker with Compose, and the provider credentials described below.

```bash
cp .env.example .env
docker compose up -d mongodb
bun install --frozen-lockfile
bun run dev
```

Open the origin configured in `APP_URL` (`http://localhost:3007` by default). The app can render public pages without credentials; authentication, readiness, billing, and playlist APIs require their respective environment values.

`nuxt dev` does not run a persistent TypeScript checker (that watcher is what pushed idle memory over 1GB). Use `bun run typecheck` or `bun run check` instead. Nuxt DevTools stays off unless you start the app with `NUXT_DEVTOOLS=true`. Local MongoDB is started with a 256MB WiredTiger cache so it does not reserve half of system RAM while idle.

Run checks:

```bash
bun run check
bun run format:check
bun run build
```

Run the complete container stack:

```bash
docker compose up --build
```

## Logging

Server logging follows the Strautomator standard through `anyhow`. Development output is timestamped and includes `INFO`, `WARN`, or `ERROR` plus a component name such as `OAuth.finish`, `Sync.run`, or `Creem.processEvent`.

Production containers set `JSON_LOGGING=true` and emit one JSON object per line with GCP-compatible severity names, for example `{"severity":"INFO","message":"..."}`. This format is also ingested by AWS CloudWatch and other container log collectors. Set `JSON_LOGGING=false` to retain human-readable output in a production process.

Logged paths include server/database lifecycle, OAuth and sessions, provider requests and token refresh, sync runs and reconciliation counts, scheduled batches, task changes, and Creem billing/webhooks. OAuth codes, tokens, raw webhook payloads, authorization headers, secrets, and email addresses are not logged; `maskSecrets` is also enabled as a second line of defense.

## Credentials needed for testing

### Shared application values

- `APP_URL`: exact externally visible origin, without a path, such as `http://localhost:3007` or `https://dev.playlistsyncer.com`. OAuth callbacks, billing redirects, webhook documentation, and same-origin request checks derive from this value. `NUXT_PUBLIC_SITE_URL` remains supported as a legacy fallback.
- `SESSION_SECRET`: any non-empty string; use a unique, high-entropy value in production
- `TOKEN_ENCRYPTION_KEY`: any non-empty string; the service derives a 256-bit AES key from it
- `SCHEDULER_SECRET`: any non-empty string; callers send this exact value as the bearer token
- `MONGODB_URI` and `MONGODB_DATABASE`

Optional SMTP values for email confirmation after social registration without a provider email:

- `SMTP_HOST`, `SMTP_PORT` (587 by default), `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`
- When SMTP is not configured, confirmation emails are skipped. In non-production the account page can expose a development confirmation link.

For local development, set `DEVELOPMENT_PRO_USER_EMAILS` to a comma-separated list of account email addresses that should receive effective PRO access without a subscription. The override is ignored whenever `NODE_ENV=production`, and affected accounts are labeled as development overrides in the UI.

Set `PRO_SUBSCRIPTION_REQUIRED_AT` to the ISO 8601 instant when PRO features start requiring a paid subscription, for example `2027-01-01T00:00:00.000Z`. Until that instant, every signed-in account receives complimentary PRO access so the service can be tested with the full feature set. Once the instant has passed, accounts without a paid subscription (or development override) drop to Free: extra sync tasks stay saved but locked, and only the first playlist pair remains enabled. Leave the variable empty to require a subscription immediately.

Provider API pacing is configured with `SPOTIFY_MAX_REQUESTS_PER_MINUTE` (default 120), `YOUTUBE_MAX_REQUESTS_PER_MINUTE` (default 300), `TIDAL_MAX_REQUESTS_PER_MINUTE` (default 60), and `AMAZON_MAX_REQUESTS_PER_MINUTE` (default 60). Each limit is shared by all accounts of that provider; `0` disables pacing while keeping the rate limit cooldown.

Changing `TOKEN_ENCRYPTION_KEY` without a key-rotation migration makes stored OAuth tokens unreadable. Provider client secrets, database credentials, and webhook signing secrets are externally issued credentials and must still be configured exactly as provided.

### Spotify

Create a Spotify Web API app and supply `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${APP_URL}/api/auth/spotify/callback
```

Scopes requested: `user-read-email`, `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, and `playlist-modify-public`. Current Spotify policy may require Premium and development-mode user allowlisting during testing.

### Google / YouTube Music

Enable YouTube Data API v3, configure the OAuth consent screen, create a Web application OAuth client, and supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${APP_URL}/api/auth/youtube/callback
```

Scopes requested: `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/youtube`. Add test users while the consent screen is in testing mode. Playlist synchronization uses official YouTube video playlists visible in YouTube Music, not an unofficial YouTube Music API.

### TIDAL

Create a TIDAL Developer Platform app and supply `TIDAL_CLIENT_ID` and `TIDAL_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${APP_URL}/api/auth/tidal/callback
```

Scopes requested: `user.read`, `playlists.read`, `playlists.write`, and `search.read`. Playlist synchronization uses the official TIDAL JSON:API at `https://openapi.tidal.com/v2`. User-owned playlists are listed, created as unlisted, and matched by ISRC when available.

### Amazon

Supply Login with Amazon values in `AMAZON_CLIENT_ID` and `AMAZON_CLIENT_SECRET`, with this exact return URL:

```text
${APP_URL}/api/auth/amazon/callback
```

The approved Amazon Music partner API documentation is still needed to implement its playlist adapter. Specifically provide the API base URL, authorization/scopes, playlist list/items schemas, catalog search contract, add/remove/reorder operations, pagination, quotas, and sandbox details. `AMAZON_MUSIC_API_BASE_URL` is reserved for that approved endpoint. Login works independently; playlist calls intentionally return `501` until the contract is implemented.

### Creem

Create a recurring PRO Product and supply:

- `CREEM_API_KEY`
- `CREEM_PRO_PRODUCT_ID`
- `CREEM_WEBHOOK_SECRET`
- `CREEM_SERVER`: `test` for sandbox billing or `prod` for live billing
- `NUXT_PUBLIC_PRO_PRICE`, fallback display label such as `9.99 EUR`. When `CREEM_API_KEY` is set, startup loads the price of the `CREEM_PRO_PRODUCT_ID` product and uses this value only if that lookup fails.

Register the HTTPS webhook endpoint:

```text
${APP_URL}/api/webhooks/creem
```

Subscribe to Creem checkout and subscription events. At minimum, enable `checkout.completed`, `subscription.paid`, `subscription.active`, `subscription.trialing`, `subscription.update`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.expired`, `subscription.past_due`, `subscription.unpaid`, and `subscription.paused`. Configure the endpoint and copy its signing secret from the Creem dashboard's Developers section.

## Scheduled jobs

Invoke the portable due-task endpoint from Cloud Scheduler, EventBridge Scheduler, cron, or any HTTPS scheduler:

```bash
curl -X POST "$APP_URL/api/jobs/sync-due" \
	-H "Authorization: Bearer $SCHEDULER_SECRET"
```

Call it at least every 12 hours; hourly is recommended because the endpoint selects only tasks whose own `nextRunAt` is due. It processes at most ten tasks per call, with MongoDB leases preventing concurrent runs. A targeted retry is available at `POST /api/jobs/sync-task/:id` with the same bearer token.

Send weekly PRO playlist summaries with the same bearer token:

```bash
curl -X POST "$APP_URL/api/jobs/weekly-sync-summary" \
	-H "Authorization: Bearer $SCHEDULER_SECRET"
```

Call it at least once a week; hourly is safe because each opted-in PRO account is due only every seven days. The job emails a playlist-by-playlist list of added and removed tracks, and skips the send when nothing changed. It processes at most 25 accounts per call.

## Runtime endpoints

- `GET /api/health`: process liveness, no dependencies
- `GET /api/ready`: MongoDB connectivity
- `POST /api/jobs/sync-due`: authenticated scheduled batch
- `POST /api/jobs/weekly-sync-summary`: authenticated weekly PRO sync summary emails
- `POST /api/webhooks/creem`: Creem-signed subscription events

## Deployment notes

The production image listens on `0.0.0.0:$PORT`, runs as the image's non-root `bun` user, and contains no environment files or secrets. Supply environment variables through the target platform's secret manager. MongoDB should be a replica set for production resilience, configured with TLS, authentication, backups, and network access restricted to the service.
