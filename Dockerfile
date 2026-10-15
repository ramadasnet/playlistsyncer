FROM oven/bun:1.4.3-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.3-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3007
ENV PLS_JSON_LOGGING=true
# Bun closes idle requests after 10 s by default; 255 s is its maximum.
ENV NITRO_BUN_IDLE_TIMEOUT=255
COPY --from=builder --chown=bun:bun /app/.output ./.output
COPY --from=builder --chown=bun:bun /app/server ./server
COPY --from=builder --chown=bun:bun /app/shared ./shared
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=bun:bun /app/jobs.json ./jobs.json
USER bun
EXPOSE 3007
EXPOSE 3008
# Jobs override this with `bun run jobs`, which preloads the same file.
CMD ["bun", "run", "--preload", "./server/preload.ts", ".output/server/index.mjs"]
