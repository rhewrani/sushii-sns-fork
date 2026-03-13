# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun dev              # Run with pino-pretty log formatting (development)
bun start            # Run without log formatting (production-like)
bun run typecheck    # TypeScript type checking (no emit)
bun test             # Run tests (*.test.ts files)
```

To run a single test file:
```bash
bun test src/platforms/twitter/downloader.test.ts
```

## Architecture

**sushii-sns** is a Discord bot that downloads media from social media platforms (Twitter/X, Instagram posts, Instagram stories, TikTok) when users post links prefixed with `dl` in whitelisted channels. It also extracts attachment links from replied-to messages when the command `links` is sent as a reply.

### Entry point flow

`src/index.ts` → creates a `discord.js` Client, registers `MessageCreate` handler, starts a Hono HTTP healthcheck server on port 8080.

`src/handlers/MessageCreate.ts` → filters messages to whitelisted channels (from `CHANNEL_ID_WHITELIST` env var), then runs `snsHandler` and `extractLinksHandler` in parallel via `Promise.allSettled`.

### SNS downloader pattern

All downloaders live in `src/platforms/<name>/downloader.ts` and extend the abstract `SnsDownloader<M>` class (`src/platforms/base.ts`). Each downloader implements:

- `PLATFORM` — platform identifier string
- `URL_REGEX` — regex to match platform URLs
- `createLinkFromMatch(match)` — builds `SnsLink<M>` from regex capture groups
- `buildApiRequest(details)` — constructs the fetch `Request`
- `fetchContent(snsLink, progressCallback?)` — full fetch + download pipeline, returns `PostData<M>[]`
- `buildDiscordAttachments(postData)` — returns `MessageCreateOptions[]` with file buffers (sent first to get CDN URLs)
- `buildDiscordMessages(postData, attachmentURLs)` — returns `MessageCreateOptions[]` with formatted text + CDN links

The `snsHandler` in `src/handlers/sns.ts` orchestrates: finds all links → streams results via async generator → sends attachments → sends formatted messages with CDN URLs.

### Platform implementations

| Directory | Platform | API |
|-----------|----------|-----|
| `src/platforms/twitter/` | Twitter/X | fxtwitter.com API |
| `src/platforms/instagram-post/` | Instagram posts/reels | Brightdata datasets API (async: trigger → poll progress → fetch snapshot) |
| `src/platforms/instagram-story/` | Instagram stories (profile URL) | RapidAPI instagram-scraper-api2 |
| `src/platforms/tiktok/` | TikTok | RapidAPI |

Instagram posts use an async scraping flow: trigger a snapshot job, poll `BdMonitorResponse` until `status === "ready"`, then fetch the snapshot data.

### Other handlers

- `src/handlers/sns.ts` — orchestrates SNS downloads; triggered by messages starting with `dl`
- `src/handlers/links.ts` — triggered by reply with `links` command; extracts attachment URLs from the referenced message and sends them chunked into ≤2000-char messages

### Utilities

- `src/utils/discord.ts` — `itemsToMessageContents` (chunks URL lists into ≤2000-char Discord messages), `chunkArray`, `formatDiscordTitle`, `MAX_ATTACHMENTS_PER_MESSAGE` (10), `KST_TIMEZONE`
- `src/utils/http.ts` — `fetchWithHeaders` (adds User-Agent header), `getFileExtFromURL`
- `src/utils/heic.ts` — converts HEIC buffers to JPEG via `sharp`
- `src/logger.ts` — pino logger instance
- `src/config/config.ts` — zod-validated env config (exits on invalid env)

### Required environment variables

```
DISCORD_TOKEN
APPLICATION_ID
BD_API_TOKEN        # Brightdata API token for Instagram posts
RAPID_API_KEY       # RapidAPI key for Instagram stories and TikTok
CHANNEL_ID_WHITELIST  # Comma-separated Discord channel IDs
```

Optional: `LOG_LEVEL` (default: `info`), `SENTRY_DSN`
