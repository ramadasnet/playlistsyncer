# PlaylistSyncer (BETA)

**This app is not in production yet!!! No migrations are necessary!**

An open-source service that allows users to sync their playlists among multiple music providers.

- Two-way sync: changes made to a playlist on one service will also update the playlist on the other service.
- One-way sync: one provider acts as the master, and the playlist on the other provider is a mirror of the master.
- Full sync: all playlists from one provider are synced to the other provider.
- Automatic sync: background jobs will sync the playlists automatically every few hours / days, depending on settings.
  Supported providers: Spotify, YouTube Music, TIDAL, and SoundCloud.

## Stack

- TypeScript + Nuxt 4 running on Bun
- MongoDB database, also compatible with Google Firestore and Amazon DocumentDB
- Platform agnostic, should run anywhere using Docker or PM2
- Creem is used for billing and payments

## Architecture and persistence

MongoDB collections hold:

- users and their effective Free or PRO entitlement
- encrypted provider credentials and provider account identities
- opaque sessions and short-lived OAuth transactions
- synchronization tasks, account-level playlist mappings, leases, and next-run times
- playlist baselines and synchronization run history
- idempotently processed Creem webhook event IDs

Indexes enforce unique users, provider identities, sessions, OAuth states, snapshots, and webhook events. TTL indexes remove sessions, OAuth transactions, and search misses when `expiresAt` passes, sync runs after 180 days, and webhook events after 90 days. The `sync-cleanup` job deletes sync runs sooner (after 3 months by default), deletes those same expired documents on its schedule, and removes inactive accounts without sync tasks, see [Scheduled jobs](#scheduled-jobs). When the database user cannot create TTL indexes, that job is what removes the expired documents.

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
- If the source playlist is deleted, the failed run can restore it once by copying the target playlist back. That restore does not change the task's usual direction.

### Full sync

- If the user selects `ALL Playlists` as the source, a full sync will consider the first provider the master and the second provider the mirror.
- Each source playlist is matched to its durable destination mapping, then by an unclaimed playlist with the same name, or created as a new playlist if it doesn't exist.
- When a previously mapped source playlist disappears, its destination and mapping are retained. That destination is not reused for another source playlist with the same name, and synchronization resumes if the original source returns.
- Every execution acquires a database lease and records additions, removals, conflicts, skipped tracks, and failures. A single playlist starts with 15 minutes. A full sync starts with 15 minutes plus 5 minutes for each additional playlist. While the run is still working, the lease is extended by 5 minutes at a time. This prevents overlapping manual and scheduled runs of the same task.

## Plans and scheduling

- Free: one playlist-pair task, weekly scheduled runs, and a 24-hour cooldown between successful manual runs.
- PRO: unlimited playlist-pair and whole-account tasks, scheduled every 720 minutes (12 hours) by default, with no manual-run cooldown. Every account can open the latest run's added, removed, and unmatched tracks. Browsing past runs is a PRO feature. An optional weekly email lists playlists and tracks added or removed, and is sent only when there were changes.
- Complimentary trial: set `PLS_PRO_SUBSCRIPTION_REQUIRED_AT` to an ISO 8601 instant. Until that moment, every account has effective PRO access without a subscription and can still start checkout to keep PRO afterward.

Creem webhook events are the source of truth for paid entitlement. The `subscription-sync` job re-reads Creem on the 1st and 15th and repairs a status or payment date that a missed webhook left behind. Downgrades and the end of the complimentary trial retain tasks and history. Extra playlist-pair tasks and every whole-account task are paused with an entitlement lock: they cannot run or be edited, and the UI explains that a PRO subscription is needed. The earliest playlist-pair task stays enabled on Free. In local development, `PLS_DEVELOPMENT_PRO_USER_EMAILS` can grant an explicitly labeled PRO override without creating a subscription.

## Authentication and security

The service has no manual registration process. Instead, users are registered as soon as they login with an account from any of the available music providers. If the provider does not share a verified email, the user is signed in and sent to the account page to enter (and then confirm) an email address.

An already authenticated user may explicitly link another provider account, but only one account per provider. Sessions are opaque, server-stored, and delivered in secure HTTP-only cookies.

## Rate limits

The music providers have strict rate limits, and these are set via environment variables per provider.

Provider API requests retry rate limits up to 5 times and honor cooldowns up to 5 minutes; longer cooldowns fail with 429 instead of queueing. The limiter is in memory for each process. The website and the jobs process do not share it, so running both, or more than one instance of either, might trigger 429 more often.

## Logging

Development logging output is timestamped and includes `INFO`, `WARN`, or `ERROR` plus a component name / reference such as `OAuth.finish`, `Sync.run`, or `Creem.processEvent`.

Secrets will be masked automatically, except for `DEBUG` which might contain the full response or request trail.

## Environment variables

Application settings use the `PLS_` prefix.

| Variable                                 | Description                                                                                                                                  | Default when unset                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`                               | Runtime mode; production enables secure cookies and production logging.                                                                      | `development` locally; PM2 sets `production`                                        |
| `HOST`                                   | Address the production HTTP server binds to.                                                                                                 | `localhost` in dev; PM2 sets `0.0.0.0` for the website                              |
| `PORT`                                   | Port the production HTTP server listens on.                                                                                                  | `3007`                                                                              |
| `PLS_JOBS_PORT`                          | Port the separate scheduled-jobs HTTP server listens on.                                                                                     | `3008`                                                                              |
| `NITRO_BUN_IDLE_TIMEOUT`                 | Seconds the website keeps an idle request open (Bun's maximum is 255).                                                                       | Bun's 10 s; PM2 sets `255` for the website                                          |
| `NITRO_PRESET`                           | Nuxt build output target.                                                                                                                    | `bun` (also set by the build script)                                                |
| `PLS_APP_URL`                            | Base app URL including http(s); used for OAuth callbacks and origin checks. Production requires a public `https` origin.                     | `http://localhost:3007` in development; `https://playlistsyncer.com/` in production |
| `PLS_APP_NAME`                           | Public application name.                                                                                                                     | `PlaylistSyncer`                                                                    |
| `PLS_DEVTOOLS`                           | Enable Nuxt DevTools only when set to `true`.                                                                                                | `false`                                                                             |
| `PLS_SUPPORT_EMAIL`                      | Public support address and fallback SMTP sender address.                                                                                     | Unset                                                                               |
| `PLS_CHATBASE_HELP_URL`                  | Public help-chat URL.                                                                                                                        | Unset                                                                               |
| `PLS_JSON_LOGGING`                       | Emit JSON severity logs instead of plain text                                                                                                | `false`; PM2 sets `true` for the website                                            |
| `PLS_SHUTDOWN_TIMEOUT_SECONDS`           | Seconds a stopping process waits for its in-flight sync runs before marking them failed; keep it below PM2's kill grace period.              | `8`                                                                                 |
| `PLS_SAFE_MODE`                          | Block writes to music providers and log the intended changes.                                                                                | `false`                                                                             |
| `PLS_SESSION_SECRET`                     | Secret used for server-side session and email-confirmation tokens.                                                                           | Unset; required for sessions and for a production website start                     |
| `PLS_TOKEN_ENCRYPTION_KEY`               | Key material for encrypting provider tokens and OAuth verifiers.                                                                             | Unset; required for OAuth and for a production start                                |
| `PLS_SCHEDULER_SECRET`                   | Bearer secret protecting scheduled job endpoints.                                                                                            | Unset; required for jobs and for a production jobs start                            |
| `PLS_MONGODB_URI`                        | MongoDB connection URI.                                                                                                                      | Unset                                                                               |
| `PLS_MONGODB_DATABASE`                   | Database name within MongoDB.                                                                                                                | `playlistsyncer`                                                                    |
| `PLS_SMTP_HOST`                          | SMTP server for confirmation and summary emails; omitting it disables delivery.                                                              | Unset                                                                               |
| `PLS_SMTP_PORT`                          | SMTP server port (465 uses implicit TLS; other ports require STARTTLS).                                                                      | `587`                                                                               |
| `PLS_SMTP_USER`                          | SMTP authentication username.                                                                                                                | Unset                                                                               |
| `PLS_SMTP_PASSWORD`                      | SMTP authentication password.                                                                                                                | Unset                                                                               |
| `PLS_SMTP_FROM`                          | Sender name and address for outgoing mail.                                                                                                   | `PlaylistSyncer <PLS_SUPPORT_EMAIL>`                                                |
| `PLS_DEVELOPMENT_PRO_USER_EMAILS`        | Comma-separated email addresses with a PRO override in development only.                                                                     | Empty list                                                                          |
| `PLS_PRO_SUBSCRIPTION_REQUIRED_AT`       | ISO 8601 cutoff for complimentary PRO access in both scheduling and public plan copy; absent means a subscription is required immediately.   | Unset                                                                               |
| `PLS_TASKSYNC_INTERVAL`                  | Minutes after a successful PRO sync until the next automatic run is due; also controls the public cadence label. Must be a positive integer. | `720` (12 hours)                                                                    |
| `PLS_SPOTIFY_CLIENT_ID`                  | Spotify OAuth client ID.                                                                                                                     | Unset                                                                               |
| `PLS_SPOTIFY_CLIENT_SECRET`              | Spotify OAuth client secret.                                                                                                                 | Unset                                                                               |
| `PLS_GOOGLE_CLIENT_ID`                   | Google OAuth client ID for YouTube.                                                                                                          | Unset                                                                               |
| `PLS_GOOGLE_CLIENT_SECRET`               | Google OAuth client secret for YouTube.                                                                                                      | Unset                                                                               |
| `PLS_TIDAL_CLIENT_ID`                    | TIDAL OAuth client ID.                                                                                                                       | Unset                                                                               |
| `PLS_TIDAL_CLIENT_SECRET`                | TIDAL OAuth client secret.                                                                                                                   | Unset                                                                               |
| `PLS_SOUNDCLOUD_CLIENT_ID`               | SoundCloud OAuth client ID.                                                                                                                  | Unset                                                                               |
| `PLS_SOUNDCLOUD_CLIENT_SECRET`           | SoundCloud OAuth client secret.                                                                                                              | Unset                                                                               |
| `PLS_AMAZON_CLIENT_ID`                   | Login with Amazon client ID.                                                                                                                 | Unset                                                                               |
| `PLS_AMAZON_CLIENT_SECRET`               | Login with Amazon client secret.                                                                                                             | Unset                                                                               |
| `PLS_AMAZON_MUSIC_API_BASE_URL`          | Reserved endpoint for an approved Amazon Music partner API.                                                                                  | Unset                                                                               |
| `PLS_SPOTIFY_MAX_REQUESTS_PER_MINUTE`    | Shared Spotify request pacing; `0` disables pacing.                                                                                          | `120`                                                                               |
| `PLS_YOUTUBE_MAX_REQUESTS_PER_MINUTE`    | Shared YouTube request pacing; `0` disables pacing.                                                                                          | `300`                                                                               |
| `PLS_TIDAL_MAX_REQUESTS_PER_MINUTE`      | Shared TIDAL request pacing; `0` disables pacing.                                                                                            | `60`                                                                                |
| `PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE` | Shared SoundCloud request pacing; `0` disables pacing.                                                                                       | `60`                                                                                |
| `PLS_AMAZON_MAX_REQUESTS_PER_MINUTE`     | Shared Amazon request pacing; `0` disables pacing.                                                                                           | `60`                                                                                |
| `PLS_USER_PROVIDER_REQUESTS_PER_MINUTE`  | Requests one user can make per minute, counted separately on each web process, to routes that call music providers; `0` disables the limit.  | `30`                                                                                |
| `PLS_CREEM_API_KEY`                      | Creem API credential for checkout and price lookup.                                                                                          | Unset                                                                               |
| `PLS_CREEM_PRO_PRODUCT_ID`               | Creem product charged at PRO checkout and used for the displayed price.                                                                      | Unset                                                                               |
| `PLS_CREEM_WEBHOOK_SECRET`               | Secret used to verify Creem webhook signatures.                                                                                              | Unset                                                                               |
| `PLS_CREEM_SERVER`                       | Creem environment: `test` or `prod`.                                                                                                         | `prod` when `NODE_ENV=production`, `test` otherwise                                 |

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
- `PLS_USER_PROVIDER_REQUESTS_PER_MINUTE` (default 30) caps how often one user can load playlists, request match suggestions, or start syncs, so a single account cannot use up the shared provider limits. Each user can also request at most 5 confirmation emails per hour. Both caps are counted in memory on each web process, so another process keeps its own count.

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

Created playlists are private. SoundCloud updates playlist membership by replacing the full track list (track URNs), not by adding or removing individual items. Replacements of one playlist run one at a time in this process. A queued removal still deletes the track from the earlier read after another write changes its position, and only as many copies as that read asked to remove. A replacement is refused when an entry has no track URN so that entry is not deleted. Tracks that SoundCloud rejects with `422` cannot be added. SoundCloud does not publish an aggregate request cap for these playlist calls; `PLS_SOUNDCLOUD_MAX_REQUESTS_PER_MINUTE` still paces this app (default 60). Their published limit applies to play streams, which PlaylistSyncer does not request.

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
- `PLS_CREEM_SERVER`: `test` for sandbox billing or `prod` for live billing (the default in production)
  Set the first three together: a production start with only some of them fails. When `PLS_CREEM_API_KEY` is set, startup loads the price of the `PLS_CREEM_PRO_PRODUCT_ID` product. The public display falls back to `9.99 EUR` if that lookup fails.

Register the HTTPS webhook endpoint:

```text
${PLS_APP_URL}/api/webhooks/creem
```

Subscribe to Creem checkout and subscription events. At minimum, enable `checkout.completed`, `subscription.paid`, `subscription.active`, `subscription.trialing`, `subscription.update`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.expired`, `subscription.past_due`, `subscription.unpaid`, and `subscription.paused`. Configure the endpoint and copy its signing secret from the Creem dashboard's Developers section.

## Running locally

Prerequisites: Bun 1.4+, optionally Docker Compose for a local MongoDB container, and the provider credentials described below.

```bash
cp .env.example .env
docker compose up -d mongodb
bun install --frozen-lockfile
bun run dev
```

Start the scheduled-jobs process in a second terminal. It listens on `PLS_JOBS_PORT` (`3008` by default) and is not part of the website process:

```bash
bun run jobs
```

Open the origin configured in `PLS_APP_URL` (`http://localhost:3007` by default). The app can render public pages without credentials; authentication, billing, and playlist APIs require their respective environment values.

Please note that `nuxt dev` does not run a persistent TypeScript checker and has the DevTools disabled to minimize memory usage. Use `bun run typecheck` or `bun run check`, and the `PLS_DEVTOOLS=true` env variable setting if you want to enable those. Local MongoDB is started with a 256MB WiredTiger cache, also to minimize memory usage.

Run checks:

```bash
bun run check
bun run format:check
bun run build
```

## Running in production

Prerequisites: Bun 1.4+ on the host, and a managed MongoDB (or MongoDB-compatible) database deployed, and the secrets from `.env.example`.

### Docker

**Image file: `ghcr.io/ramadasnet/playlistsyncer:latest`**

The `Dockerfile` builds one image for both processes. It sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3007` and `NITRO_BUN_IDLE_TIMEOUT=255`. The default command starts the website and the jobs process in one container with `pm2-runtime` and `ecosystem.config.cjs`; PM2 restarts either process if it crashes. To run them in separate containers instead, override the command with `bun run start` (website) or `bun run jobs` (jobs).

On the server, copy `.env.example` to `.env` and fill in production values (`PLS_APP_URL` must be a public `https` origin). Docker reads `.env` literally, so do not put quotes around values.

When deploying it standalone, make sure to set `PLS_MONGODB_URI` in `.env` to an address that the containers can reach. `localhost` in a container is the container itself, not the host.

```bash
docker build -t playlistsyncer .
docker run -d --name playlistsyncer --restart unless-stopped \
	--env-file .env -p 3007:3007 -p 127.0.0.1:3008:3008 playlistsyncer
```

Or as two containers, so each process can be restarted independently:

```bash
docker run -d --name playlistsyncer-app --restart unless-stopped \
	--env-file .env -p 3007:3007 playlistsyncer bun run start
docker run -d --name playlistsyncer-jobs --restart unless-stopped \
	--env-file .env -e PLS_JOBS_PORT=3008 -p 127.0.0.1:3008:3008 playlistsyncer bun run jobs
```

To deploy updates, pull the changes, build the image again, then remove and run the containers again with the same commands. In a single container, the website and jobs process share CPU and memory limits, and a container health check on port `3007` does not cover the jobs process.

### Secrets from Infisical

Instead of putting every secret in `.env`, the processes can load them from Infisical when they start. Create a machine identity with Universal Auth and read access to the project environment, then set only `PLS_INFISICAL_CLIENT_ID`, `PLS_INFISICAL_CLIENT_SECRET` and `PLS_INFISICAL_PROJECT_ID` (plus `PLS_INFISICAL_ENVIRONMENT` if it is not `prod`) in `.env`. Store the other variables in Infisical with the same names.

| Variable                      | Description                                                                                     | Default when unset                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `PLS_INFISICAL_CLIENT_ID`     | Infisical Universal Auth client ID; when set, startup loads the other variables from Infisical. | Unset; Infisical is not used                   |
| `PLS_INFISICAL_CLIENT_SECRET` | Infisical Universal Auth client secret.                                                         | Unset; required with `PLS_INFISICAL_CLIENT_ID` |
| `PLS_INFISICAL_PROJECT_ID`    | Infisical project ID.                                                                           | Unset; required with `PLS_INFISICAL_CLIENT_ID` |
| `PLS_INFISICAL_ENVIRONMENT`   | Infisical environment slug.                                                                     | `prod`                                         |
| `PLS_INFISICAL_SECRET_PATH`   | Infisical folder path that holds the secrets.                                                   | `/`                                            |
| `PLS_INFISICAL_SITE_URL`      | Infisical instance URL, for the EU cloud or a self-hosted instance.                             | `https://app.infisical.com`                    |

The website and the jobs process preload `server/preload.ts` before reading configuration. Development (`make run`), `bun run start`, `bun run jobs`, and PM2 (also used by the default Docker command) pass that preload explicitly. Builds, typechecks, and tests do not contact Infisical. Variables that already have a value in the environment are kept, so values in `.env` or `compose.yaml` win over Infisical. If Infisical cannot be reached, the process exits and the restart policy tries again. Secrets are never written to disk or baked into the image; rotate a secret in Infisical and restart the processes to apply it.

### Docker Compose

The `compose.yaml` builds the image and runs three services: `app` (website on port `3007`), `jobs` (jobs server on `127.0.0.1:3008`) and `mongodb` (MongoDB with a persistent `mongodb-data` volume). It sets `PLS_MONGODB_URI` to the `mongodb` service, so the value in `.env` is not used. The services start in order, after the health check of the earlier service passes: `mongodb`, then `jobs`, then `app`.

```bash
docker compose up -d --build
docker compose logs -f app jobs
```

Deploy updates after pulling changes with `docker compose up -d --build`. Stop everything with `docker compose down`. The MongoDB data stays in the volume.

To use a managed MongoDB instead, remove the `mongodb` service, the `PLS_MONGODB_URI` overrides and the `mongodb` entries under `depends_on`, then set `PLS_MONGODB_URI` in `.env`. The bundled `mongodb` service publishes port `27017` on all host interfaces without authentication. On a public server, change it to `127.0.0.1:27017:27017` or remove the `ports` entry.

`docker stop` waits 10 seconds before it kills a container, so keep `PLS_SHUTDOWN_TIMEOUT_SECONDS` below that. Put a reverse proxy in front of port `3007` and keep port `3008` off the public internet.

### With PM2

Make sure [PM2](https://pm2.keymetrics.io/) is installed globally: `npm install -g pm2`. (The Docker image uses its own copy from `node_modules`.)

On the server, copy `.env.example` to `.env`, fill in production values (`PLS_APP_URL` must be a public `https` origin), then build and start both processes:

```bash
bun install --frozen-lockfile
bun run build
pm2 start ecosystem.config.cjs
pm2 save
```

`ecosystem.config.cjs` runs the website from `.output/server/index.mjs` on `PORT` (`3007` by default) and the jobs server from `server/jobs/main.ts` on `PLS_JOBS_PORT` (`3008`). It loads `.env`, sets `NODE_ENV=production`, and applies the same defaults as the Docker image for logging and Bun idle timeouts.

Deploy updates after pulling changes:

```bash
make pm2-deploy
```

That runs `bun install --frozen-lockfile`, `bun run build`, and `pm2 reload ecosystem.config.cjs --update-env`. Use `make pm2-stop` and `make pm2-logs` to stop processes or follow logs.

Put a reverse proxy (nginx, Caddy, etc.) in front of the website port. Leave the jobs port on localhost; it serves health checks and manual job triggers.

## Scheduled jobs

Scheduled work runs inside the jobs process (`bun run jobs`), not in the website process. On startup that process reads `jobs.json` from the project root and runs each entry on its own UTC cron schedule. The same jobs stay available as authenticated HTTP endpoints, so you can still trigger one by hand.

`jobs.json` is an array. Each entry has a `name`, a `schedule`, and optional `parameters`:

| `name`                | What it runs                                                                       | Parameters                             |
| --------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| `sync-due`            | Up to `limit` sync tasks whose `nextRunAt` is due (default 10, maximum 100)        | `limit`                                |
| `weekly-sync-summary` | Weekly PRO playlist summaries for up to `limit` accounts (default 25, maximum 100) | `limit`                                |
| `sync-task`           | One synchronization task                                                           | `id` (required): the task's MongoDB id |
| `sync-cleanup`        | Deletes expired documents, old sync runs, and inactive users without tasks         | See below                              |
| `subscription-sync`   | Reconciles Creem subscription status and payment dates onto each account           | None                                   |

`schedule` is a 5-field cron expression (`minute hour day month weekday`) evaluated in UTC, or one of `@hourly`, `@daily`, `@weekly`, and `@monthly`. When both day-of-month and weekday are restricted, the job runs if either matches. A job that is still running when its next tick arrives is skipped until it finishes. The committed file runs `sync-due` at the top of every hour, `weekly-sync-summary` at 15 minutes past every hour, `sync-cleanup` every Sunday and Wednesday at 05:00 UTC, and `subscription-sync` at 06:00 UTC on the 1st and 15th.

`PLS_TASKSYNC_INTERVAL` still sets how long after a successful PRO sync that task becomes due again. The cron expression only decides how often the jobs process looks for due work. Hourly is enough for the default 720-minute interval. Weekly summaries can run hourly too: each opted-in PRO account is due only every seven days, and a call with no changes does not send mail.

`subscription-sync` lists subscriptions from Creem and writes the current status, billing period, and payment dates onto the matching account. A paid status (`active`, `trialing`, or `scheduled_cancel`) keeps PRO. Any other status returns the account to Free. Accounts are matched by Creem customer id, then by the `userId` saved at checkout, then by email when exactly one account has that address. A stored subscription that Creem no longer has is marked canceled. Subscriptions for a product other than `PLS_CREEM_PRO_PRODUCT_ID` are left untouched. When several subscriptions belong to one account, the one that still grants PRO wins.

If `jobs.json` is missing, the process still serves the HTTP endpoints and does not run jobs on its own. An invalid file stops startup.

`sync-cleanup` deletes expired sessions, OAuth transactions, and search misses, webhook events older than 90 days, and sync runs older than 180 days even when `runRetentionMonths` is longer. It only warns or deletes users who have no sync tasks and no renewing PRO subscription. A login updates the user's `lastLoginAt` and cancels a pending deletion. Parameters:

| Parameter            | Default | What it does                                                                                   |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `runRetentionMonths` | 3       | Deletes sync runs older than this many months, never past 180 days                             |
| `warnAfterMonths`    | 12      | Emails users who have not logged in for this many months that their account will be deleted    |
| `deleteAfterMonths`  | 12      | Deletes users who have not logged in for this many months                                      |
| `deletionGraceDays`  | 30      | Minimum days between the warning email and the deletion. Users without an email are not warned |
| `limit`              | 100     | Maximum users to warn, and maximum users to delete, per call (maximum 100)                     |

### Triggering a job manually

```bash
curl -X POST "http://127.0.0.1:3008/api/jobs/sync-due" \
	-H "Authorization: Bearer $PLS_SCHEDULER_SECRET"
```

```bash
curl -X POST "http://127.0.0.1:3008/api/jobs/weekly-sync-summary" \
	-H "Authorization: Bearer $PLS_SCHEDULER_SECRET"
```

```bash
curl -X POST "http://127.0.0.1:3008/api/jobs/subscription-sync" \
	-H "Authorization: Bearer $PLS_SCHEDULER_SECRET"
```

A single task can be run with `POST /api/jobs/sync-task/:id` and the same bearer token. MongoDB leases prevent concurrent runs of the same task. Keep `PLS_JOBS_PORT` (`3008` by default) off the public internet.

## Runtime endpoints

Website process:

- `GET /api/health`: HTTP 200 with `status: "ok"` only when MongoDB accepts a connection check; HTTP 503 with `status: "unhealthy"` otherwise
- `POST /api/webhooks/creem`: Creem-signed subscription events

Jobs process (`PLS_JOBS_PORT`):

- `GET /api/health`: same MongoDB connection check as the website process
- `POST /api/jobs/sync-due`: authenticated scheduled batch
- `POST /api/jobs/sync-task/:id`: authenticated run of one task
- `POST /api/jobs/weekly-sync-summary`: authenticated weekly PRO sync summary emails
- `POST /api/jobs/sync-cleanup`: authenticated cleanup of old sync runs, other expired documents, and inactive users, with the default parameters
- `POST /api/jobs/subscription-sync`: authenticated Creem subscription reconciliation

## Deployment notes

The website listens on `0.0.0.0:$PORT` and the jobs process on `0.0.0.0:$PLS_JOBS_PORT`. Keep secrets in `.env` on the host (or inject them through your provisioning layer); do not commit them. MongoDB (or whatever MongoDB-compatible database) should be a replica set for production resilience, configured with TLS, authentication, backups, and network access restricted to the service.

With `NODE_ENV=production`, both processes refuse to start (exit code 1) when `PLS_MONGODB_URI` or `PLS_TOKEN_ENCRYPTION_KEY` is missing, when `PLS_APP_URL` is not a public `https` origin, or when Creem is only partially configured. The website also requires `PLS_SESSION_SECRET`, and the jobs process requires `PLS_SCHEDULER_SECRET`. A missing `PLS_SMTP_HOST` only logs a warning.

On `SIGTERM` or `SIGINT`, the website answers new requests with 503. The jobs server stops accepting new connections and stops scheduling new jobs from `jobs.json`. A client opening a new connection does not receive that 503. A request that reaches the jobs app on an already open connection does. The jobs process stops starting due tasks. Each process waits up to `PLS_SHUTDOWN_TIMEOUT_SECONDS` for the sync runs it started, and the jobs process also waits for scheduled jobs and accepted non-sync requests, such as a weekly summary or subscription reconciliation, before closing MongoDB. Tracked runs still going at the deadline are marked failed. A sync start that has not recorded its run ID by the deadline can remain running.

If using PM2 in production: PM2's `kill_timeout` in `ecosystem.config.cjs` is 10 seconds; keep `PLS_SHUTDOWN_TIMEOUT_SECONDS` below that.
