# Cloud Agent base image for PlaylistSyncer.
# Stable system toolchain only: Bun (pinned to the repo version) and MongoDB.
# Repository dependencies are installed later by .cursor/install.sh against the
# checked-out source, and MongoDB is started per-boot by .cursor/start.sh.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling needed to fetch and run everything else.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        openssl \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# MongoDB 8.0 (matches compose.yaml's mongo:8.x) from the official repository.
RUN curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
        | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor \
    && echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-8.0.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends mongodb-org \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/db /var/log/mongodb \
    && chown -R ubuntu:ubuntu /data/db /var/log/mongodb

# Bun, pinned to the version declared in the Dockerfile at the repo root.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0" \
    && bun --version

USER ubuntu
