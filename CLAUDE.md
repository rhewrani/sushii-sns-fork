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
bun test src/handlers/sns/downloaders/twitter.test.ts
```

## Architecture

**sushii-sns** is a Discord bot that downloads media from social media platforms (Twitter/X, Instagram posts, Instagram stories, TikTok) when users post links prefixed with `dl` in whitelisted channels. It also extracts attachment links from replied-to messages when the command `links` is sent as a reply.

### Entry point flow

`src/index.ts` → creates a `discord.js` Client, registers `MessageCreate` handler, starts a Hono HTTP healthcheck server on port 8080.

`src/handlers/MessageCreate.ts` → filters messages to whitelisted channels (from `CHANNEL_ID_WHITELIST` env var), then runs `snsHandler` and `extractLinksHandler` in parallel via `Promise.allSettled`.

### SNS downloader pattern

All downloaders live in `src/handlers/sns/downloaders/` and extend the abstract `SnsDownloader<M>` class (`base.ts`). Each downloader implements:

- `PLATFORM` — platform identifier string
- `URL_REGEX` — regex to match platform URLs
- `createLinkFromMatch(match)` — builds `SnsLink<M>` from regex capture groups
- `buildApiRequest(details)` — constructs the fetch `Request`
- `fetchContent(snsLink, progressCallback?)` — full fetch + download pipeline, returns `PostData<M>[]`
- `buildDiscordAttachments(postData)` — returns `MessageCreateOptions[]` with file buffers (sent first to get CDN URLs)
- `buildDiscordMessages(postData, attachmentURLs)` — returns `MessageCreateOptions[]` with formatted text + CDN links

The `snsHandler` in `src/handlers/sns/handler.ts` orchestrates: finds all links → streams results via async generator → sends attachments → sends formatted messages with CDN URLs.

### Platform implementations

| File | Platform | API |
|------|----------|-----|
| `downloaders/twitter.ts` | Twitter/X | fxtwitter.com API |
| `downloaders/instagramPost.ts` | Instagram posts/reels | Brightdata datasets API (async: trigger → poll progress → fetch snapshot) |
| `downloaders/instagramStory.ts` | Instagram stories (profile URL) | RapidAPI instagram-scraper-api2 |
| `downloaders/tiktok.ts` | TikTok | RapidAPI |

Instagram posts use an async scraping flow: trigger a snapshot job, poll `BdMonitorResponse` until `status === "ready"`, then fetch the snapshot data.

### Other handlers

- `src/handlers/links/handler.ts` — triggered by reply with `links` command; extracts attachment URLs from the referenced message and sends them chunked into ≤2000-char messages.
- `src/handlers/calendar/` — calendar utilities (types and helpers in `cal.ts`, `types.ts`, `utils.ts`).

### Utilities

- `src/handlers/util.ts` — `itemsToMessageContents` (chunks URL lists into ≤2000-char Discord messages), `chunkArray`
- `src/handlers/sns/downloaders/util.ts` — `formatDiscordTitle`, `getFileExtFromURL`, `fetchWithHeaders`, `MAX_ATTACHMENTS_PER_MESSAGE` (10), `KST_TIMEZONE`
- `src/handlers/sns/downloaders/heic.ts` — converts HEIC buffers to JPEG via `sharp`
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
