#!/usr/bin/env bash
# Idempotent repository bootstrap for Cloud Agents.
# Installs JS dependencies against the checked-out source and creates a local
# development .env (with throwaway dev secrets) when one is not already present.
#
# Optional external database: if a PLS_MONGODB_URI environment secret is provided
# (for example a MongoDB Atlas connection string), it is written into .env so the
# app targets that database instead of the local MongoDB. When no PLS_MONGODB_URI is
# set, the environment falls back to the local MongoDB started by start.sh.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

env_file=".env"

# Replace (or append) a KEY=VALUE line in .env. Writes the value literally, so it
# is safe for connection strings containing :/@?&+ and other shell/sed specials.
set_env_var() {
    local key="$1" value="$2"
    if [ -f "$env_file" ]; then
        grep -v "^${key}=" "$env_file" > "${env_file}.tmp" || true
        mv "${env_file}.tmp" "$env_file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
}

# Create a local dev env file if the agent does not already have one.
# Secrets here are random, development-only values; real provider credentials
# are supplied out of band via environment secrets.
if [ ! -f "$env_file" ]; then
    echo "Creating .env from .env.example with generated dev secrets"
    cp .env.example "$env_file"
    for var in PLS_SESSION_SECRET PLS_TOKEN_ENCRYPTION_KEY PLS_SCHEDULER_SECRET; do
        set_env_var "$var" "$(openssl rand -hex 32)"
    done
fi

# Honor an external MongoDB (e.g. Atlas) supplied as an environment secret.
# Making .env authoritative keeps the app consistent regardless of how the
# runtime resolves .env versus process environment precedence.
if [ -n "${PLS_MONGODB_URI:-}" ]; then
    echo "External PLS_MONGODB_URI detected; pointing .env at the provided database"
    set_env_var PLS_MONGODB_URI "$PLS_MONGODB_URI"
    if [ -n "${PLS_MONGODB_DATABASE:-}" ]; then
        set_env_var PLS_MONGODB_DATABASE "$PLS_MONGODB_DATABASE"
    fi
fi

# Install dependencies exactly as pinned by bun.lock (runs `nuxt prepare` via postinstall).
bun install --frozen-lockfile

echo "install.sh complete"
