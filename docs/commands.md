# Bot commands

Two families: **message commands** (`dl`, `links`) in whitelisted channels, and **slash commands** (registered globally at startup).

Environment basics: `CHANNEL_ID_WHITELIST`, `DISCORD_TOKEN`, `APPLICATION_ID`. Monitor also needs `MONITORS_CONFIG_PATH` and API keys per [CLAUDE.md](../CLAUDE.md).

## 1. `dl` — download media

Send a message whose content **starts with** `dl` (then a space or URL). The bot matches supported platform URLs and downloads media into the channel.

```text
dl https://x.com/user/status/1234567890
dl https://www.instagram.com/p/SHORTCODE/
dl https://www.tiktok.com/@user/video/1234567890
```

- Only runs in channels listed in `CHANNEL_ID_WHITELIST`.
- Reactions + optional progress messaging while fetching.
- User-facing errors may use [`snsErrors.ts`](../src/handlers/snsErrors.ts); repeated provider failures can trigger [`opsAlert`](../src/utils/opsAlert.ts).

## 2. `links` — attachment URLs

Reply to **any message** with the exact text `links` (after trimming). The bot sends attachment URLs from the referenced message, chunked to Discord’s length limit. On failure, the error line uses the same ops user resolution as alerts ([`formatLinksFailureReply`](../src/utils/opsAlert.ts)).

## 3. Slash commands

Registered in [`commands.ts`](../src/handlers/monitor/commands.ts). All require **Manage Server** (`ManageGuild`) except where noted.

| Command | Purpose |
|---------|---------|
| `/usage` | API usage counters for this process (`scope`: all / providers / endpoints). Handled in [`usageSlash.ts`](../src/handlers/usageSlash.ts). |
| `/monitor panel setup` | Run **in** `panel_channel_id`: post/pin or refresh the monitor panel embed. |
| `/monitor panel refresh` | Refresh the panel embed if it already exists. |
| `/monitor db purge-connection` | Purge seen-post + cooldown data for one `type` + `handle`. |
| `/monitor db purge-all` | Purge all connection metadata and seen posts (destructive). |
| `/post url:` | Fetch a single post URL and send it to `socials_channel_id` (with duplicate checks when configured). |
| `/fetch-all` | Requires monitor enabled: mark-seen sync for every connection, refresh panel; **no** review messages. |

If `MONITORS_CONFIG_PATH` is unset, `/fetch-all` replies that the monitor is disabled; `/monitor` and `/post` still exist in the app but monitor-specific behavior needs the config + DB.

## Related docs

- [architecture.md](./architecture.md) — entrypoint, HTTP routes, file layout.
- [monitor-feature.md](./monitor-feature.md) — connections, DB, review prefixes.
- [platforms.md](./platforms.md) — per-platform URLs and APIs.
