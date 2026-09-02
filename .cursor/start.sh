#!/usr/bin/env bash
# Per-boot startup: bring up MongoDB and wait until it accepts connections.
# Idempotent: reuses an already-running mongod and cleans up a stale lock.
#
# Optional external database: when a MONGODB_URI environment secret points at a
# non-local host (for example MongoDB Atlas), the local MongoDB is not started
# and this script returns immediately; the app connects to the external database.
set -euo pipefail

# Skip the local database when an external MongoDB is configured via secret.
if [ -n "${MONGODB_URI:-}" ]; then
    case "$MONGODB_URI" in
        *localhost*|*127.0.0.1*)
            : # Local target: fall through and start the bundled MongoDB.
            ;;
        *)
            echo "External MONGODB_URI detected; skipping local MongoDB startup."
            exit 0
            ;;
    esac
fi

mkdir -p /data/db /var/log/mongodb

if pgrep -x mongod >/dev/null 2>&1; then
    echo "mongod already running"
else
    # Remove a stale lock left by an unclean shutdown so mongod can restart.
    rm -f /data/db/mongod.lock
    mongod \
        --dbpath /data/db \
        --bind_ip 127.0.0.1 \
        --port 27017 \
        --logpath /var/log/mongodb/mongod.log \
        --fork
fi

# Wait for readiness before returning so dependent services can connect.
for _ in $(seq 1 30); do
    if mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; then
        echo "mongod ready on 127.0.0.1:27017"
        exit 0
    fi
    sleep 1
done

echo "mongod did not become ready in time" >&2
exit 1
