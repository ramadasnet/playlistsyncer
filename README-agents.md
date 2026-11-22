# PlaylistSyncer — agent briefing

Syncs playlists between music providers (Spotify, YouTube Music, TIDAL, SoundCloud, Apple Music, Amazon). One repo ships three processes — user site, admin site, scheduled-jobs worker — plus a browser extension.

## Stack

- TypeScript, Nuxt 4 (Nitro `bun` preset), Vue 3, Pinia, zod — Bun (CI pins 1.4.3), `bun.lock`
- MongoDB-compatible DB (`mongo:9` in compose; Atlas and Firestore-Mongo also supported)
- oauth4webapi for provider OAuth; PM2 runs production (`ecosystem.config.cjs`: `playlistsyncer` + `playlistsyncer-jobs`)
- Tests: `bun test` (`tests/`); typecheck: `nuxt typecheck` (vue-tsc); Prettier via `format`/`format:check`
- `admin/` — separate Nuxt app (own `package.json`, `nuxt.config.ts`, `Dockerfile`); not part of the consumer build
- `extension/` — Chrome/Firefox extension, built by `extension/build.ts` → `extension/dist/*.zip`

## Commands

- dev site: `make dev` — `scripts/dev.mjs` runs Nuxt on :3007 plus the Cloudflare Tunnel; `bun run dev` = Nuxt only
- dev admin: `make admin` — admin Nuxt on :3009 (separate `.github/workflows/admin.yml` CI)
- jobs worker: `make jobs` — `server/jobs/main.ts` on :3008, schedule defined in `jobs.json`
- verify: `bun run check` (= `make check`: typecheck + tests) — what `ci.yml` runs on PRs/master
- DB only: `make db` — `docker compose up -d mongodb`
- migrations: `bun run migrate` — `scripts/migrate.ts`
- extension: `bun run extension:build` / `bun run extension:typecheck` (`tsc -p extension`)
- prod (PM2): `make pm2-deploy` (install+build+reload) · `pm2-start` · `pm2-stop` · `pm2-logs`
- deps+version: `make update` — `bun update` + date-version `YY.WWD.1HHMM`

## Conventions

- Every env var is `PLS_`-prefixed; full list with comments in `.env.example`
- `server/preload.ts` is passed via `bun --preload` by all dev/start/PM2 commands — it fills env from Infisical when `PLS_INFISICAL_CLIENT_ID` is set; always launch through package.json scripts/Make targets, never bare `nuxt`
- `package.json` `reviewAgents`: draft PRs → @greptile, ready PRs → @cubic
- `admin/` is excluded from the root tsconfig, the root `nuxt.config.ts` `ignore`, and the main CI `paths-ignore`
- Bun reads `.env` natively; PM2 additionally passes `env_file: .env`

## Corner cases

- `PLS_SAFE_MODE=true` blocks all writes to music providers and logs what would change
- Spotify dev-app quota: `PLS_SPOTIFY_CREDENTIALS` accepts a comma-separated `id:secret` pool; rollover per `PLS_SPOTIFY_MAX_USERS_PER_APP`
- Firestore-with-Mongo-compat URIs need `loadBalanced=true&tls=true&retryWrites=false` (+`authMechanism=MONGODB-OIDC` on GCP) — see `.env.example`
- Keep `PLS_SHUTDOWN_TIMEOUT_SECONDS` below PM2 `kill_timeout` (10 s) or in-flight syncs get marked failed
- `nuxt dev` runs with `--no-fork` + preload; forking would skip Infisical loading
- `.cloudflared/` holds the named-tunnel material used by `make dev` (git-ignored)

## Pointers

- `README.md` — sync semantics (two-way/one-way/full), TTL/lease model, provider quirks, full env reference · `extension/README.md` — extension internals · `REVIEW.md` — PR review-bot instructions
