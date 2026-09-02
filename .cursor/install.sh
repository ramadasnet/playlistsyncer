#!/usr/bin/env bash
# Idempotent repository bootstrap for Cloud Agents.
# Installs JS dependencies against the checked-out source and creates a local
# development .env (with throwaway dev secrets) when one is not already present.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Create a local dev env file if the agent does not already have one.
# Secrets here are random, development-only values; real provider credentials
# are supplied out of band via environment secrets.
if [ ! -f .env ]; then
    echo "Creating .env from .env.example with generated dev secrets"
    cp .env.example .env
    for var in SESSION_SECRET TOKEN_ENCRYPTION_KEY SCHEDULER_SECRET; do
        secret="$(openssl rand -hex 32)"
        sed -i "s|^${var}=.*|${var}=${secret}|" .env
    done
fi

# Install dependencies exactly as pinned by bun.lock (runs `nuxt prepare` via postinstall).
bun install --frozen-lockfile

echo "install.sh complete"
