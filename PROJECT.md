# PlaylistSyncer

An open-source service that allows users to sync their playlists among multiple music providers.

## Features

- Two-way sync: changes made to a playlist on one service will also update the playlist on the other service.
- One-way sync: one provider acts as the master, and the playlist on the other provider is a mirror of the master.
- Full sync: all playlists from one provider are synced to the other provider.
- Missing track suggestions: use a similar track as a replacement if the target provider does not have the exact same one as the original playlist.
- Automatic sync: background jobs will sync the playlists automatically every few hours / days, depending on settings.
- Supported providers: Spotify, YouTube Music, TIDAL, and SoundCloud.

The service has two plans, Free and PRO:

- Free: one playlist-pair task, weekly scheduled runs, and a 24-hour cooldown between successful manual runs.
- PRO: unlimited playlist-pair and whole-account tasks, scheduled every 720 minutes (12 hours) by default, with no manual-run cooldown. Every account can open the latest run's added, removed, and unmatched tracks. Browsing past runs is a PRO feature. An optional weekly email lists playlists and tracks added or removed, and is sent only when there were changes.

## Stack

- TypeScript + Nuxt 4 running on Bun
- MongoDB database, also compatible with Google Firestore and Amazon DocumentDB
- Platform agnostic, should run anywhere using Docker
- Creem is used for billing and payments

## Deployment

- Always run `bun update` to update to the latest dependencies before each deployment.
