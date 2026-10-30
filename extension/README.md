# PlaylistSyncer browser extension

Chrome and Firefox (Manifest V3) extension that runs Spotify and Amazon Music operations for PlaylistSyncer inside the user's own browser session, using the providers' web player APIs.

## Build

```sh
bun run extension:build                                          # production server (https://playlistsyncer.com)
PLS_EXTENSION_SERVER_URL=http://localhost:3007 bun run extension:build   # local dev server
bun run extension:typecheck
```

The output goes to `extension/dist/chrome` and `extension/dist/firefox` (plus zip files when the `zip` command is available). The version comes from the root `package.json`.

## Load unpacked

- **Chrome**: open `chrome://extensions`, enable Developer mode, click "Load unpacked" and pick `extension/dist/chrome`.
- **Firefox** (128+): open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…" and pick `extension/dist/firefox/manifest.json`. If Firefox did not grant the site access at install, the popup shows an "Allow access" button.

## Redirect URI

Linking uses OAuth 2.0 with PKCE through `identity.launchWebAuthFlow`. The server only accepts redirect URIs listed in its `PLS_EXTENSION_REDIRECT_URIS` setting:

- Chrome: `https://<extension-id>.chromiumapp.org/` (the ID is shown on `chrome://extensions`).
- Firefox: the value of `browser.identity.getRedirectURL()`, usually `https://<hash>.extensions.allizom.org/`.

The popup shows the exact redirect URI of the installed extension while it is not linked.

## How it works

- The background script long-polls `POST /api/extension/poll`, runs the queued commands (max 2 at a time per provider) and posts each result to `/api/extension/results`. Scheduled task checks run at most every 30 minutes and only while the system has been idle or locked for a minute; the schedule is kept by an alarm and a persisted timestamp, and polling stays live while commands run, while the website is the active tab, or shortly after the popup is used.
- Providers live in `src/providers/` (one file per provider implementing `ProviderConnector`, registered in `src/providers/index.ts`). The contract with the server is `shared/types/extension.ts`.
- Provider requests run inside a provider tab (an existing one, or an inactive tab opened by the extension and closed after 2 idle minutes by a cleanup alarm).

## Security model

- Spotify and Amazon tokens and cookies never leave the browser: requests run inside the provider's own web page, and captured headers are only stored in the extension's local storage.
- Only playlist and track data (names, IDs, ISRCs, durations) and the signed-in provider account names are sent to PlaylistSyncer.
- The PlaylistSyncer token is a revocable bearer token stored in the extension's local storage and sent without cookies. Disconnecting revokes it.
