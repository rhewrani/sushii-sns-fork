# Architecture Overview

Sushii-SNS is a private Discord bot designed for content managers to make social media content sharing easier and automate tedious tasks. This document explains the high-level architecture of the application and the exact code flows to help contributors understand how to modify the codebase.

## Core Setup

The bot is written in **TypeScript** and executed using **Bun**. It relies on `discord.js` to interface with the Discord API.

The main entry point is `src/index.ts`. On startup, the bot:
1. Loads configuration files from `config.ts` and `server_config.ts`.
2. Initializes a new `discord.js` client with intents to read guild messages.
3. Sets up event listeners for `MessageCreate` (for standard messages) and `InteractionCreate` (for UI button and modal interactions).
4. Spins up a health check Hono HTTP server running on port 8080.
5. If configured, it registers the Instagram Monitor system routing.

## Directory Structure

- **`index.ts`**: The central entry point. Orchestrates Discord client initialization, event routing (`MessageCreate`, `InteractionCreate`), and health check server.
- **`config/`**: Handles loading JSON configurations and `.env` parsing.
- **`handlers/`**: Core Discord event pipelines.
  - `MessageCreate.ts`: Standard message pipeline for link detection.
  - `sns.ts`: Detects and processes social media link commands (`dl`).
  - `monitor/`: Contains the interactive SNS monitor system.
    - `interactions.ts`: **Dispatcher for all Buttons, Modals, and Slash Commands.**
    - `fetch.ts`: Logic for API scraping (Brightdata/RapidAPI) and database filtering.
    - `review.ts`: In-memory state management for pending post reviews.
- **`platforms/`**: Website-specific scrapers (Twitter, Instagram, TikTok).
- **`utils/`**: Helper functions for Discord UI, Image conversion (HEIC -> JPEG), and networking.

## Code Flow: Processing a `dl` Download Request

When a user pastes a command like `dl https://x.com/user/status/123`, the following exact code flow is executed:

1. **`MessageCreateHandler` (`src/handlers/MessageCreate.ts`)**
   - Ignores bot messages and DMs.
   - Validates that the channel ID is present in the `CHANNEL_ID_WHITELIST`.
   - Dispatches the message concurrently to `extractLinksHandler` and `snsHandler`.

2. **Trigger Validation (`src/handlers/sns.ts`)**
   - The `snsHandler` checks if the message string starts with `"dl"`.
   - It iterates through the instantiated array of `downloaders` calling `.findUrls(content)`.
   - If URLs are matched via regex, it triggers intermediate UI updates (Discord reactions and a "Downloading..." edit message).

3. **Content Fetching (The Async Generator)**
   - The handler yields to `snsService()`, an async generator function.
   - This invokes the specific platform's `fetchContent()` method. The platform fetches the media buffers, determines the file extension (e.g., MP4 or JPG), and returns an array of `PostData` objects (containing the files, caption, timestamp, etc.).

4. **Discord UI Formatting & Delivery**
   - The async generator passes the `PostData` back to `snsHandler`.
   - **Step A:** `platform.buildDiscordAttachments()` wraps the raw `Buffer`s in `discord.js` `AttachmentBuilder` objects.
   - **Step B:** The bot sends *just* these attachments to the channel. This forces Discord to upload the media to its CDN and return CDN URLs.
   - **Step C:** `platform.buildDiscordMessages()` generates the final text message containing the original caption linked specifically to those fresh Discord CDN URLs.
   - **Step D:** The bot replies to the original message with the processed text payload.

## Code Flow: Interactive UI (Buttons & Modals)

Unlike simple text commands, the Monitor system relies on Discord's Interaction API. The flow for a button click (e.g., "Poll") is:

1. **`InteractionCreate` (`src/index.ts`)**
   - The Discord client receives an interaction and passes it to `handleInteraction` in `src/handlers/monitor/interactions.ts`.

2. **Dispatcher (`interactions.ts`)**
   - The dispatcher checks the `customId` of the interaction (Button, Select Menu, or Modal).
   - It uses **Prefix Matching** (defined in `review.ts`) to route the interaction. E.g., `customId.startsWith("monitor:poll:")` routes to `handlePanelPollButton`.

3. **State Stateful Handling**
   - **Persistent State**: The bot queries SQLite to check cooldowns or connection metadata.
   - **Ephemeral State**: For multi-step flows like "Reviewing a post," the bot stores the raw media and pending edits in an in-memory `Map` (`pendingReviews` in `review.ts`).

4. **UI Updates**
   - The handler acknowledges the interaction using `interaction.update()` (to refresh the message in place) or `interaction.showModal()` (to prompt for text input).

## Storage and Database

The bot uses SQLite (`bun:sqlite`) via `src/handlers/monitor/db.ts` to persist:
- **`panel_messages`**: IDs of pinned monitor embeds for global status updates.
- **`connection_meta`**: Runtime statistics and cooldown timestamps per connection.
- **`monitor_seen_posts`**: A history of processed post IDs to prevent duplicate alerts.
