# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun dev              # Run with pino-pretty log formatting (development)
bun start            # Run without log formatting (production-like)
bun run typecheck    # TypeScript type checking (no emit)
bun test             # Run tests (*.test.ts files)
INTEGRATION=1 bun test  # Also run integration tests (real API calls)
```

To run a single test file:

```bash
bun test src/platforms/twitter/downloader.test.ts
```

## Deeper docs

- [docs/architecture.md](docs/architecture.md) — code flows, directory map
- [docs/monitor-feature.md](docs/monitor-feature.md) — Instagram monitor (connections, review queue)
- [docs/platforms.md](docs/platforms.md), [docs/commands.md](docs/commands.md)

## Architecture

**sushii-sns** downloads media from Twitter/X, Instagram posts/reels, Instagram stories, and TikTok when users post links prefixed with `dl` in whitelisted channels. It also extracts attachment URLs when someone replies with `links` to a message.

### Entry point flow

`src/index.ts` — loads env (`config/config.ts`), optional `server_config.json`, registers Discord handlers, **always** registers slash commands, starts a Hono HTTP server on **port 8080** (`src/server/botHttp.ts`).

`src/handlers/MessageCreate.ts` — filters to `CHANNEL_ID_WHITELIST`, runs `extractLinksHandler` and `snsHandler` in parallel via `Promise.allSettled`.

`InteractionCreate` — `/usage` → `handlers/usageSlash.ts`; monitor UI → `handlers/monitor/interactions.ts` when `MONITORS_CONFIG_PATH` is set and metadata DB is open.

### HTTP routes (port 8080)

- `GET /` — simple text
- `GET /v1/health` — `OK` / `500` from gateway-style health (`clientHealthy`)
- `GET /v1/ready` — Discord client ready
- `GET /v1/uptime` — process and bot uptime JSON
- `GET /v1/status` — health, ping, guild count, memory (JSON)

Request logging uses `hono/logger` middleware.

### SNS downloader pattern

Downloaders live in `src/platforms/<name>/downloader.ts` and extend `SnsDownloader<M>` (`src/platforms/base.ts`):

- `PLATFORM`, `URL_REGEX`, `createLinkFromMatch`, `buildApiRequest`, `fetchContent`, `buildDiscordAttachments`, `buildDiscordMessages`

`snsHandler` (`src/handlers/sns.ts`) finds links, streams via `snsService`, sends attachments then formatted replies. Shared link discovery is exported as `findAllSnsLinks` / `snsService` for the monitor pipeline.

### Platform implementations

| Directory | Platform | API |
|-----------|----------|-----|
| `src/platforms/twitter/` | Twitter/X | api.fxtwitter.com |
| `src/platforms/instagram-post/` | Posts/reels | Bright Data datasets (async snapshot) |
| `src/platforms/instagram-story/` | Stories | RapidAPI (URL shape `.../stories/{username}/{storyId}/`) |
| `src/platforms/tiktok/` | TikTok | RapidAPI |

### Monitor feature (optional)

When `MONITORS_CONFIG_PATH` points to a JSON config:

- **Connections** (not legacy “subscriptions”): each maps Instagram sources → review channel → destination channel; panel lives in `panel_channel_id`.
- **SQLite**: `DB_PATH` metadata DB includes panel state, connection fetch meta, and `monitor_seen_posts`. See `src/handlers/monitor/db.ts`, `schema.ts`.
- **Queue**: `handlers/monitor/queue.ts` serializes post jobs with timeout.
- **Ops alerts**: `src/utils/opsAlert.ts` (optional `ALERT_DISCORD_USER_ID`).

### Other notable modules

- `src/apiUsage.ts` — usage counters for external APIs
- `src/utils/fallback.ts` — `tryWithFallbacks` for multi-provider fetches
- `src/utils/opsAlert.ts` — public-channel failure alerts
- `src/utils/discord.ts` — chunking, titles, `sendPostToChannel` (review/monitor posting)
- `src/utils/http.ts` — `fetchWithHeaders`, `getFileExtFromURL`
- `src/utils/socialUrls.ts` — small URL parsers (e.g. TikTok username from URL)
- `src/handlers/snsErrors.ts` — user-facing SNS error strings / ops alert gating
- `src/config/config.ts` — zod-validated env (exits on invalid env)

### Required environment variables

```
DISCORD_TOKEN
APPLICATION_ID
BD_API_TOKEN          # Bright Data (Instagram posts)
RAPID_API_KEY         # Instagram stories + TikTok
CHANNEL_ID_WHITELIST  # Comma-separated Discord channel IDs
```

### Optional environment variables

| Variable | Notes |
|----------|--------|
| `LOG_LEVEL` | Default `info` |
| `SENTRY_DSN` | Error tracking |
| `SERVER_CONFIG_PATH` | Guild routing / feature flags (`server_config.json`) |
| `MONITORS_CONFIG_PATH` | Enables monitor + slash commands beyond `/usage` |
| `DB_PATH` | Default `./data.db` (metadata; connection DBs live alongside) |
| `ALERT_DISCORD_USER_ID` | Ops mention for alerts; empty string disables mention |
| `MONITOR_DEV_MODE` | See `src/handlers/monitor/runtime.ts` |
