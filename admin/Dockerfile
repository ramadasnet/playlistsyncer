FROM oven/bun:1.4.3-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY admin ./admin
COPY server ./server
COPY shared ./shared
RUN bun run admin:build

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3009
ENV NITRO_BUN_IDLE_TIMEOUT=255
COPY --from=builder --chown=bun:bun /app/admin/.output ./admin/.output
COPY --from=builder --chown=bun:bun /app/server/preload.ts ./server/preload.ts
COPY --from=builder --chown=bun:bun /app/server/utils/infisical.ts ./server/utils/infisical.ts
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
USER bun
EXPOSE 3009
CMD ["bun", "--preload", "./server/preload.ts", "admin/.output/server/index.mjs"]
