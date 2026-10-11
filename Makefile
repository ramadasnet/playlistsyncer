# Clean compiled resources and dependencies
clean:
	rm -rf ./.nuxt
	rm -rf ./.output
	rm -rf ./node_modules
	rm -f bun.lock

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

# Run the app locally (dev server with hot reload)
run: db
	bun run dev

# Run the scheduled jobs process locally
jobs:
	bun run jobs

# Build and reload both production processes under PM2
deploy: install build
	pm2 reload ecosystem.config.cjs --update-env

# Start both production processes under PM2 (first deploy)
prod-start:
	pm2 start ecosystem.config.cjs

# Stop both production processes
prod-stop:
	pm2 stop ecosystem.config.cjs

# Tail PM2 logs for both processes
prod-logs:
	pm2 logs

# Update dependencies (within their semver ranges) and set new version
update:
	bun update
	npm pkg set version=$(shell date '+%y.%-V%u.1%H%M')
	bun run check

.PHONY: clean install build check test format db run jobs deploy prod-start prod-stop prod-logs update
