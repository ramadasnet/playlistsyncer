FROM oven/bun:1.4.0-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.0-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1.4.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV JSON_LOGGING=true
ENV HOST=0.0.0.0
ENV PORT=3007
COPY --from=builder --chown=bun:bun /app/.output ./.output
USER bun
EXPOSE 3007
CMD ["bun", "run", ".output/server/index.mjs"]
