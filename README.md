# PlaylistSyncer (BETA)

An open-source service that allows users to sync their playlists among multiple music providers.

- Two-way sync: changes made to a playlist on one service will also update the playlist on the other service.
- One-way sync: one provider acts as the master, and the playlist on the other provider is a mirror of the master.
- Full sync: all playlists from one provider are synced to the other provider.
- Automatic sync: background jobs will sync the playlists automatically every few hours / days, depending on settings.
  Supported providers: Spotify, YouTube Music, TIDAL, and SoundCloud.

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
- When a previously mapped source playlist disappears, its destination and mapping are retained. That destination is not reused for another source playlist with the same name, and synchronization resumes if the original source returns.
- Every execution acquires a 15-minute database lease and records additions, removals, conflicts, skipped tracks, and failures. This prevents overlapping manual and scheduled runs of the same task.

## Plans and scheduling

- Free: one playlist-pair task, weekly scheduled runs, and a 24-hour cooldown between successful manual runs.
- PRO: unlimited playlist-pair and whole-account tasks, scheduled every 720 minutes (12 hours) by default, with no manual-run cooldown. Every account can open the latest run's added, removed, and unmatched tracks. Browsing past runs is a PRO feature. An optional weekly email lists playlists and tracks added or removed, and is sent only when there were changes.
- Complimentary trial: set `PLS_PRO_SUBSCRIPTION_REQUIRED_AT` to an ISO 8601 instant. Until that moment, every account has effective PRO access without a subscription and can still start checkout to keep PRO afterward.

Creem webhook events are the source of truth for paid entitlement. Downgrades and the end of the complimentary trial retain tasks and history. Extra playlist-pair tasks and every whole-account task are paused with an entitlement lock: they cannot run or be edited, and the UI explains that a PRO subscription is needed. The earliest playlist-pair task stays enabled on Free. In local development, `PLS_DEVELOPMENT_PRO_USER_EMAILS` can grant an explicitly labeled PRO override without creating a subscription.

## Authentication and security

The service has no manual registration process. Instead, users are registered as soon as they login with an account from any of the available music providers. If the provider does not share a verified email, the user is signed in and sent to the account page to enter (and then confirm) an email address.

An already authenticated user may explicitly link another provider account, but only one account per provider. Sessions are opaque, server-stored, and delivered in secure HTTP-only cookies.

## Rate limits

The music providers have strict rate limits, and these are set via environment variables per provider.

Provider API requests retry rate limits up to 5 times and honor cooldowns up to 5 minutes; longer cooldowns fail with 429 instead of queueing. The limiter coordinates a single app instance, so running the service in multiple instances might trigger 429 more often.

## Logging

Development logging output is timestamped and includes `INFO`, `WARN`, or `ERROR` plus a component name / reference such as `OAuth.finish`, `Sync.run`, or `Creem.processEvent`.

Production containers set `PLS_JSON_LOGGING=true` and emit one JSON object per line with GCP-compatible severity names, for example `{"severity":"INFO","message":"..."}`. This format is also ingested by AWS CloudWatch and other container log collectors. Set `PLS_JSON_LOGGING=false` to retain human-readable output in a production process.

Secrets will be masked automatically, except for `DEBUG` which might contain the full response or request trail.

## Environment variables

Application settings use the `PLS_` prefix.

| Variable                              | Description                                                                                                                                  | Default when unset                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | Runtime mode; production enables secure cookies and production logging.                                                                      | Runtime-dependent; Docker sets `production`                                                             |
| `HOST`                                | Address the production HTTP server binds to.                                                                                                 | Runtime-dependent; Docker sets `0.0.0.0`                                                                |
| `PORT`                                | Port the production HTTP server listens on.                                                                                                  | Runtime-dependent; Docker sets `3007`                                                                   |
| `NITRO_PRESET`                        | Nuxt build output target.                                                                                                                    | `bun` (also set by the build script)                                                                    |
| `PLS_APP_URL`                         | Base app URL including http(s); used for OAuth callbacks and origin checks.                                                                 | `http://localhost:3007`                                                                                 |
| `PLS_APP_NAME`                        | Public application name.                                                                                                                     | `PlaylistSyncer`                                                                                        |
| `PLS_DEVTOOLS`                        | Enable Nuxt DevTools only when set to `true`.                                                                                                | `false`                                                                                                 |
| `PLS_SUPPORT_EMAIL`                   | Public support address and fallback SMTP sender address.                                                                                     | Unset; `.env.example` uses `info@playlistsyncer.com`                                                    |
| `PLS_CHATBASE_HELP_URL`               | Public help-chat URL.                                                                                                                        | Unset; `.env.example` supplies the chat URL                                                             |
| `PLS_JSON_LOGGING`                    | Emit JSON severity logs when `true` in production.                                                                                           | `false`; Docker sets `true`                                                                             |
| `PLS_SAFE_MODE`                       | Block writes to music providers and log the intended changes.                                                                                | `false`                                                                                                 |
| `PLS_SESSION_SECRET`                  | Secret used for server-side session and email-confirmation tokens.                                                                           | Unset; required for sessions                                                                            |
| `PLS_TOKEN_ENCRYPTION_KEY`            | Key material for encrypting provider tokens and OAuth verifiers.                                                                             | Unset; required for OAuth                                                                               |
| `PLS_SCHEDULER_SECRET`                | Bearer secret protecting scheduled job endpoints.                                                                                            | Unset; required for jobs                                                                                |
| `PLS_MONGODB_URI`                     | MongoDB connection URI.                                                                                                                      | Unset; `.env.example` uses `mongodb://localhost:27017/playlistsync`, Compose uses the `mongodb` service |
| `PLS_MONGODB_DATABASE`                | Database name within MongoDB.                                                                                                                | `playlistsync`                                                                                          |
| `PLS_SMTP_HOST`                       | SMTP server for confirmation and summary emails; omitting it disables delivery.                                                              | Unset                                                                                                   |
| `PLS_SMTP_PORT`                       | SMTP server port (465 uses implicit TLS; other ports require STARTTLS).                                                                      | `587`                                                                                                   |
| `PLS_SMTP_USER`                       | SMTP authentication username.                                                                                                                | Unset                                                                                                   |
| `PLS_SMTP_PASSWORD`                   | SMTP authentication password.                                                                                                                | Unset                                                                                                   |
| `PLS_SMTP_FROM`                       | Sender name and address for outgoing mail.                                                                                                   | `PlaylistSyncer <PLS_SUPPORT_EMAIL>`                                                                    |
| `PLS_DEVELOPMENT_PRO_USER_EMAILS`     | Comma-separated email addresses with a PRO override in development only.                                                                     | Empty list                                                                                              |
| `PLS_PRO_SUBSCRIPTION_REQUIRED_AT`    | ISO 8601 cutoff for complimentary PRO access in both scheduling and public plan copy; absent means a subscription is required immediately.   | Unset                                                                                                   |
| `PLS_TASKSYNC_INTERVAL`               | Minutes after a successful PRO sync until the next automatic run is due; also controls the public cadence label. Must be a positive integer. | `720` (12 hours)                                                                                        |
| `PLS_SPOTIFY_CLIENT_ID`               | Spotify OAuth client ID.                                                                                                                     | Unset                                                                                                   |
| `PLS_SPOTIFY_CLIENT_SECRET`           | Spotify OAuth client secret.                                                                                                                 | Unset                                                                                                   |
| `PLS_GOOGLE_CLIENT_ID`                | Google OAuth client ID for YouTube.                                                                                                          | Unset                                                                                                   |
| `PLS_GOOGLE_CLIENT_SECRET`            | Google OAuth client secret for YouTube.                                                                                                      | Unset                                                                                                   |
| `PLS_TIDAL_CLIENT_ID`                 | TIDAL OAuth client ID.                                                                                                                       | Unset                                                                                                   |
| `PLS_TIDAL_CLIENT_SECRET`             | TIDAL OAuth client secret.                                                                                                                   | Unset                                                                                                   |
| `PLS_SOUNDCLOUD_CLIENT_ID`            | SoundCloud OAuth client ID.                                                                                                                  | Unset                                                                                                   |
| `PLS_SOUNDCLOUD_CLIENT_SECRET`        | SoundCloud OAuth client secret.                                                                                                              | Unset                                                                                                   |
| `PLS_AMAZON_CLIENT_ID`                | Login with Amazon client ID.                                                                                                                 | Unset                                                                                                   |
| `PLS_AMAZON_CLIENT_SECRET`            | Login with Amazon client secret.                                                                                                             | Unset                                                                                                   |
| `PLS_AMAZON_MUSIC_API_BASE_URL`       | Reserved endpoint for an approved Amazon Music partner API.                                                                                  | Unset                                                                                                   |
| `PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE` | Shared Spotify request pacing; `0` disables pacing.                                                                                          | `120`                                                                                                   |
| `PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE` | Shared YouTube request pacing; `0` disables pacing.                                                                                          | `300`                                                                                                   |
| `PLS_TIDAL_MAX_REQUESTS_PER_MINUTE`   | Shared TIDAL request pacing; `0` disables pacing.                                                                                            | `60`                                                                                                    |
| `PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE` | Shared SoundCloud request pacing; `0` disables pacing.                                                                                    | `60`                                                                                                    |
| `PLS_AMAZON_MAX_REQUESTS_PER_MINUTE`  | Shared Amazon request pacing; `0` disables pacing.                                                                                           | `60`                                                                                                    |
| `PLS_CREEM_API_KEY`                   | Creem API credential for checkout and price lookup.                                                                                          | Unset                                                                                                   |
| `PLS_CREEM_PRO_PRODUCT_ID`            | Creem product charged at PRO checkout and used for the displayed price.                                                                      | Unset                                                                                                   |
| `PLS_CREEM_WEBHOOK_SECRET`            | Secret used to verify Creem webhook signatures.                                                                                              | Unset                                                                                                   |
| `PLS_CREEM_SERVER`                    | Creem environment: `test` or `prod`.                                                                                                         | `test`                                                                                                  |

## Setup guide

Some of the environment variables are optional, and will dictate which features are enabled or disabled in the service.

- Changing `PLS_TOKEN_ENCRYPTION_KEY` after deployment makes previously encrypted OAuth tokens and credentials unreadable; keep the key stable.
- To send emails, these must be set: `PLS_SMTP_HOST`, `PLS_SMTP_PORT` (587 by default), `PLS_SMTP_USER`, `PLS_SMTP_PASSWORD`, and `PLS_SMTP_FROM`.
- When SMTP is not configured, confirmation emails are skipped. In non-production the account page can expose a development confirmation link.
- For local development, set `PLS_DEVELOPMENT_PRO_USER_EMAILS` to a comma-separated list of account email addresses that should receive effective PRO access without a subscription. The override is ignored whenever `NODE_ENV=production`, and affected accounts are labeled as development overrides in the UI.
- Set `PLS_PRO_SUBSCRIPTION_REQUIRED_AT` to the ISO 8601 instant when PRO features start requiring a paid subscription, for example `2027-01-01T00:00:00.000Z`. Until that instant, every signed-in account receives complimentary PRO access so the service can be tested with the full feature set. Once the instant has passed, accounts without a paid subscription (or development override) drop back to the Free edition.
- Provider API rate limits are configured individually, set to `0` to disable:
    - `PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE` (default 120)
    - `PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE` (default 300)
    - `PLS_TIDAL_MAX_REQUESTS_PER_MINUTE` (default 60)
    - `PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE` (default 60)
    - `PLS_AMAZON_MAX_REQUESTS_PER_MINUTE` (default 60)

### Spotify

Create a Spotify Web API app and supply `PLS_SPOTIFY_CLIENT_ID` and `PLS_SPOTIFY_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${PLS_APP_URL}/api/auth/spotify/callback
```

Scopes requested: `user-read-email`, `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, and `playlist-modify-public`. Current Spotify policy may require Premium and development-mode user allowlisting during testing.

### Google / YouTube Music

Enable YouTube Data API v3, configure the OAuth consent screen, create a Web application OAuth client, and supply `PLS_GOOGLE_CLIENT_ID` and `PLS_GOOGLE_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${PLS_APP_URL}/api/auth/youtube/callback
```

Scopes requested: `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/youtube`. Add test users while the consent screen is in testing mode.

### TIDAL

Create a TIDAL Developer Platform app and supply `PLS_TIDAL_CLIENT_ID` and `PLS_TIDAL_CLIENT_SECRET`.

Register this redirect URI exactly:

```text
${PLS_APP_URL}/api/auth/tidal/callback
```

Scopes requested: `user.read`, `playlists.read`, `playlists.write`, and `search.read`.

### SoundCloud

Create a SoundCloud app and supply `PLS_SOUNDCLOUD_CLIENT_ID` and `PLS_SOUNDCLOUD_CLIENT_SECRET`. SoundCloud currently requires an Artist Pro account to register an application. PlaylistSyncer does not ship with SoundCloud credentials.

Register this redirect URI exactly:

```text
${PLS_APP_URL}/api/auth/soundcloud/callback
```

SoundCloud's authorization-code flow does not use OAuth scopes. The app sends PKCE (`S256`) and exchanges the code with the client id, client secret, and code verifier. `/me` does not include an email address, so a first login continues on the account page until an email is added and confirmed.

Created playlists are private. SoundCloud updates playlist membership by replacing the full track list (track URNs), not by adding or removing individual items. Replacements of one playlist run one at a time in this process, and a replacement is refused when an entry has no track URN so that entry is not deleted. Tracks that SoundCloud rejects with `422` cannot be added. SoundCloud does not publish an aggregate request cap for these playlist calls; `PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE` still paces this app (default 60). Their published limit applies to play streams, which PlaylistSyncer does not request.

### Amazon

**Amazon Music is currently not approving new integrations via the API, so this has NOT been tested with PlaylistSyncer yet!**

Supply Login with Amazon values in `PLS_AMAZON_CLIENT_ID` and `PLS_AMAZON_CLIENT_SECRET`, with this exact return URL:

```text
${PLS_APP_URL}/api/auth/amazon/callback
```

### Creem

Create a recurring PRO Product in your Creem account and supply:

- `PLS_CREEM_API_KEY`
- `PLS_CREEM_PRO_PRODUCT_ID`
- `PLS_CREEM_WEBHOOK_SECRET`
- `PLS_CREEM_SERVER`: `test` for sandbox billing or `prod` for live billing
When `PLS_CREEM_API_KEY` is set, startup loads the price of the `PLS_CREEM_PRO_PRODUCT_ID` product. The public display falls back to `9.99 EUR` if that lookup fails.

Register the HTTPS webhook endpoint:

```text
${PLS_APP_URL}/api/webhooks/creem
```

Subscribe to Creem checkout and subscription events. At minimum, enable `checkout.completed`, `subscription.paid`, `subscription.active`, `subscription.trialing`, `subscription.update`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.expired`, `subscription.past_due`, `subscription.unpaid`, and `subscription.paused`. Configure the endpoint and copy its signing secret from the Creem dashboard's Developers section.

## Running locally

Prerequisites: Bun 1.4+, Docker with Compose, and the provider credentials described below.

```bash
cp .env.example .env
docker compose up -d mongodb
bun install --frozen-lockfile
bun run dev
```

Open the origin configured in `PLS_APP_URL` (`http://localhost:3007` by default). The app can render public pages without credentials; authentication, billing, and playlist APIs require their respective environment values.

Please note that `nuxt dev` does not run a persistent TypeScript checker and has the DevTools disabled to minimize memory usage. Use `bun run typecheck` or `bun run check`, and the `PLS_DEVTOOLS=true` env variable setting if you want to enable those. Local MongoDB is started with a 256MB WiredTiger cache, also to minimize memory usage.

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

## Scheduled jobs

### Triggering sync tasks

Invoke the portable due-task endpoint from Cloud Scheduler, EventBridge Scheduler, cron, or any HTTPS scheduler:

```bash
curl -X POST "$PLS_APP_URL/api/jobs/sync-due" \
	-H "Authorization: Bearer $PLS_SCHEDULER_SECRET"
```

Schedule the endpoint independently from `PLS_TASKSYNC_INTERVAL`, which sets each PRO task's due time, not the scheduler's polling frequency. Call it at least as often as the configured interval (hourly is suitable for the default 720 minutes). The endpoint selects only tasks whose own `nextRunAt` is due. It processes at most ten tasks per call, with MongoDB leases preventing concurrent runs. A targeted retry is available at `POST /api/jobs/sync-task/:id` with the same bearer token.

Send weekly PRO playlist summaries with the same bearer token:

```bash
curl -X POST "$PLS_APP_URL/api/jobs/weekly-sync-summary" \
	-H "Authorization: Bearer $PLS_SCHEDULER_SECRET"
```

Call it at least once a week; hourly is safe because each opted-in PRO account is due only every seven days. The job emails a playlist-by-playlist list of added and removed tracks, and skips the send when nothing changed. It processes at most 25 accounts per call.

## Runtime endpoints

- `GET /api/health`: HTTP 200 with `status: "ok"` only when MongoDB responds to a ping; HTTP 503 with `status: "unhealthy"` otherwise
- `POST /api/jobs/sync-due`: authenticated scheduled batch
- `POST /api/jobs/weekly-sync-summary`: authenticated weekly PRO sync summary emails
- `POST /api/webhooks/creem`: Creem-signed subscription events

## Deployment notes

The production image listens on `0.0.0.0:$PORT`, runs as the image's non-root `bun` user, and contains no environment files or secrets. Supply environment variables through the target platform's secret manager. MongoDB should be a replica set for production resilience, configured with TLS, authentication, backups, and network access restricted to the service.
