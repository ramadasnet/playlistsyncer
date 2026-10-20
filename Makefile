# Clean compiled resources and dependencies
clean:
	rm -rf ./.nuxt
	rm -rf ./.output
	rm -rf ./node_modules

# Install dependencies
install:
	bun install --frozen-lockfile

# Compile and build resources
build:
	bun run build

# Run type checking and tests
check:
	bun run check

# Run tests only
test:
	bun run test

# Format the code with Prettier
format:
	bun run format

# Start only the local MongoDB container (optional for development)
db:
	docker compose up -d mongodb

# Run the scheduled jobs process locally
jobs:
	bun run jobs

# Run the user website and Cloudflare Tunnel locally
dev:
	bun run ./scripts/dev.mjs

# Run the admin site and Cloudflare Tunnel locally
admin:
	bun run ./scripts/dev.mjs --admin

# Build and reload both production processes under PM2
pm2-deploy: install build
	pm2 reload ecosystem.config.cjs --update-env

# Start both production processes under PM2 (first deploy)
pm2-start:
	pm2 start ecosystem.config.cjs

# Stop both production processes
pm2-stop:
	pm2 stop ecosystem.config.cjs

# Tail PM2 logs for both processes
pm2-logs:
	pm2 logs

# Update dependencies (within their semver ranges) and set new version
update:
	bun update
	npm pkg set version=$(shell date '+%y.%-V%u.1%H%M')
	bun run check

.PHONY: clean install build check test format db dev jobs admin pm2-deploy pm2-start pm2-stop pm2-logs update
