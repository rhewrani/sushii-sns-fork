# Architecture Overview

Sushii-SNS is a private Discord bot for content managers. This page summarizes how the app is wired; see [commands.md](./commands.md) and [monitor-feature.md](./monitor-feature.md) for user-facing behavior.

## Core setup

- **Runtime:** TypeScript on **Bun**, **discord.js** for Discord.
- **Entry:** [`src/index.ts`](../src/index.ts) loads env ([`config/config.ts`](../src/config/config.ts)), optionally JSON from `SERVER_CONFIG_PATH` via [`server_config.ts`](../src/config/server_config.ts), creates the Discord client, registers **`MessageCreate`** and **`InteractionCreate`**, and starts the HTTP server from [`src/server/botHttp.ts`](../src/server/botHttp.ts) on **port 8080**.
- **Slash commands** are registered at startup (`/monitor`, `/post`, `/usage`, `/fetch-all`). The monitor interaction handler runs when `MONITORS_CONFIG_PATH` is set and the metadata DB is open; `/usage` is handled separately ([`usageSlash.ts`](../src/handlers/usageSlash.ts)).

## HTTP (port 8080)

| Route | Purpose |
|--------|---------|
| `GET /` | Simple text response |
| `GET /v1/health` | Gateway-style health from WebSocket status |
| `GET /v1/ready` | Discord client ready |
| `GET /v1/uptime` | Process / bot uptime JSON |
| `GET /v1/status` | Health, ping, guild count, memory |

Request logging uses Hono’s logger middleware.

## Directory structure (high level)

| Area | Role |
|------|------|
| [`handlers/MessageCreate.ts`](../src/handlers/MessageCreate.ts) | Whitelist check; runs `snsHandler` and `extractLinksHandler` in parallel |
| [`handlers/sns.ts`](../src/handlers/sns.ts) | `dl` downloads; uses [`snsErrors.ts`](../src/handlers/snsErrors.ts) for user-facing errors |
| [`handlers/monitor/`](../src/handlers/monitor/) | Monitor: config, DB, **split interaction modules** (panel / post / review), [`interactions.ts`](../src/handlers/monitor/interactions.ts) dispatcher, [`fetch.ts`](../src/handlers/monitor/fetch.ts), [`queue.ts`](../src/handlers/monitor/queue.ts), [`review.ts`](../src/handlers/monitor/review.ts) |
| [`platforms/`](../src/platforms/) | Per-platform `SnsDownloader` implementations |
| [`utils/`](../src/utils/) | Discord helpers ([`discord.ts`](../src/utils/discord.ts)), HTTP, templates, [`opsAlert.ts`](../src/utils/opsAlert.ts), [`socialUrls.ts`](../src/utils/socialUrls.ts), etc. |

## Flow: `dl` download

1. **MessageCreate** — Ignore bots/DMs; require channel in `CHANNEL_ID_WHITELIST`.
2. **`snsHandler`** — Message must start with `dl`; [`findAllSnsLinks`](../src/handlers/sns.ts) aggregates all platform regex matches.
3. **`snsService`** — Async generator; each link calls the matching downloader’s `fetchContent`.
4. **Delivery** — Attachments uploaded first (CDN URLs), then `buildDiscordMessages` text replies.

## Flow: monitor interactions

1. **`InteractionCreate`** in `index.ts` routes `/usage` first, then monitor commands to [`handleInteraction`](../src/handlers/monitor/interactions.ts) when configured.
2. **Dispatcher** — Prefixes live in [`review.ts`](../src/handlers/monitor/review.ts) (e.g. `monitor:poll:`, `monitor:review:post:`). Implementation is split across [`interactionPanel.ts`](../src/handlers/monitor/interactionPanel.ts), [`interactionPost.ts`](../src/handlers/monitor/interactionPost.ts), [`interactionReview.ts`](../src/handlers/monitor/interactionReview.ts).
3. **State** — SQLite (`DB_PATH`) for panel embed, connection cooldowns, and `monitor_seen_posts` (keyed by `connection_id` + `post_id`); ephemeral review state in `review.ts`.

## Storage and database

- **Metadata DB** (path from `DB_PATH`, default `./data.db`): `monitor_panel_messages`, `monitor_connection_meta`.
- **Seen/post rows** live in **`monitor_seen_posts`** on the same DB as panel metadata.

See [monitor-feature.md](./monitor-feature.md) for config shape.
