# Instagram Monitor Feature Plan

## Context
Add semi-automated Instagram monitoring: community members press a "Fetch New Posts" button on a pinned Discord embed, the bot fetches recent posts from Brightdata and distributes to **all** servers watching that account. Multiple servers benefit from a single fetch. Each server/channel can configure its own post format and allowed role.

---

## Architecture Overview

**Config** (`monitors.json`) → subscription topology (static, requires restart to change)
**SQLite** (`monitors.db`, `bun:sqlite`) → runtime state (last fetch, seen post IDs, embed message IDs)
**InteractionCreate** → button clicks + `/monitor embed` slash command

---

## New Files

```
src/handlers/monitor/
  config.ts        — Zod schema + loadMonitorsConfig()
  db.ts            — bun:sqlite open + typed query helpers
  embed.ts         — buildStatusEmbed() → EmbedBuilder + ActionRow
  fetch.ts         — fetchAndPost(): Brightdata profile fetch, dedup, distribute
  interactions.ts  — handleInteraction(): routes buttons + slash command
  commands.ts      — registerSlashCommands() via discord.js REST
```

---

## Config File: `monitors.json`

```json
{
  "subscriptions": [
    {
      "ig_username": "lisa_bp",
      "fetch_cooldown_seconds": 300,
      "watchers": [
        {
          "guild_id": "111",
          "channel_id": "222",
          "format": "inline",
          "allowed_role_id": "333"
        },
        {
          "guild_id": "444",
          "channel_id": "555",
          "format": "links",
          "allowed_role_id": null
        }
      ]
    }
  ]
}
```

Zod schema in `config.ts`. `format` enum: `"links" | "inline"`. `allowed_role_id: null` = anyone.

---

## SQLite Schema (`db.ts`)

```sql
CREATE TABLE IF NOT EXISTS monitor_messages (
  ig_username TEXT NOT NULL,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  PRIMARY KEY (ig_username, channel_id)
);

CREATE TABLE IF NOT EXISTS monitor_fetches (
  ig_username     TEXT    NOT NULL PRIMARY KEY,
  last_fetched_at INTEGER NOT NULL,
  last_fetched_by TEXT    NOT NULL  -- display name string
);

CREATE TABLE IF NOT EXISTS monitor_seen_posts (
  ig_username TEXT    NOT NULL,
  post_id     TEXT    NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (ig_username, post_id)
);
```

Use `PRAGMA journal_mode=WAL`. Module exports typed helpers: `upsertMonitorMessage`, `getLastFetch`, `upsertLastFetch`, `isPostSeen`, `markPostSeen`, `getMonitorMessage`.

---

## Fetch Flow (`fetch.ts`)

```
Button click: monitor:fetch:{ig_username}
  1. deferReply({ ephemeral: true })
  2. Check allowed_role_id — deny if member lacks role
  3. Check cooldown via db.getLastFetch() — deny with "on cooldown, next at <t:X:R>"
  4. editReply("Fetching...")
  5. fetchIgProfilePosts(igUsername) — Brightdata trigger→poll→snapshot
     (dataset for PROFILE posts, not per-post; same trigger/poll/snapshot pattern as
     instagramPost.ts but with profile URL payload — dataset ID TBD/configurable via env)
  6. Filter against db.isPostSeen() → new posts only
  7. For each new PostData × each watcher:
       format==="links"  → postLinksFormat(channel, postData)
       format==="inline" → postInlineFormat(channel, postData)
  8. db.markPostSeen() for all new post IDs
  9. db.upsertLastFetch(igUsername, now, user.displayName)
  10. updateAllEmbeds(igUsername, client, config, db)
  11. editReply("Done! Posted N new posts.") or "No new posts found."
```

### `postLinksFormat` (reuse existing downloader)
```typescript
// instagramPost.ts downloader instance
const fileMsgs = downloader.buildDiscordAttachments(postData);
// send each → collect attachment CDN URLs
const cdnUrls = sentMessages.flatMap(m => [...m.attachments.values()].map(a => a.url));
const textMsgs = downloader.buildDiscordMessages(postData, cdnUrls);
// send each text message
```

### `postInlineFormat` (single-message, no CDN step)
```typescript
const attachments = postData.files.map((f, i) =>
  new AttachmentBuilder(f.buffer).setName(`ig-${postData.username}-${i+1}.${f.ext}`)
);
const title = formatDiscordTitle("instagram", postData.username, postData.timestamp);
const content = `${title}\n<${postData.postLink.url}>\n${postData.originalText}`.slice(0, 2000);
for (const chunk of chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE)) {
  // only first chunk gets content text
  await channel.send({ content: isFirst ? content : undefined, files: chunk, flags: MessageFlags.SuppressEmbeds });
}
```

**Existing utilities reused:**
- `formatDiscordTitle()` — `src/handlers/sns/downloaders/util.ts`
- `chunkArray()` — `src/handlers/util.ts`
- `MAX_ATTACHMENTS_PER_MESSAGE` — `src/handlers/sns/downloaders/util.ts`
- `InstagramPostDownloader.buildDiscordAttachments()` / `.buildDiscordMessages()` — for `links` format

---

## Embed (`embed.ts`)

```
📸 Instagram Monitor: @lisa_bp
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Last fetched: 3 hours ago by DisplayName
Next fetch available: Now  |  Cooldown: 300s

[📥 Fetch New Posts]  [ℹ️ Status]
```

- Discord timestamp `<t:X:R>` for relative "3 hours ago"
- `lastFetchedBy` stored as display name string (stable even if user leaves)
- Color: `0xE1306C` (Instagram pink)
- `Status` button: `deferUpdate()` → rebuild embed → `interaction.message.edit()` (ephemeral-free in-place refresh)

---

## Slash Command: `/monitor embed`

- `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)` — hidden from non-admins
- Double-checks permission in `interactions.ts` handler
- Verifies that the current channel_id is a configured watcher for the given username
- Posts embed + pins it, stores message_id in `monitor_messages`
- If existing message_id in DB: tries to edit it; if message was deleted, falls through to post new
- Registered globally via `REST.put(Routes.applicationCommands(appId))`

---

## Modified Files

### `src/config/config.ts`
Add two optional fields:
```typescript
MONITORS_CONFIG_PATH: z.string().optional(),
MONITORS_DB_PATH: z.string().optional().default("./monitors.db"),
```

### `src/index.ts`
```typescript
// Gated on MONITORS_CONFIG_PATH presence
if (config.MONITORS_CONFIG_PATH) {
  const monitorsConfig = loadMonitorsConfig(config.MONITORS_CONFIG_PATH);
  const monitorDb = openDb(config.MONITORS_DB_PATH);
  await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(interaction, client, monitorsConfig, monitorDb);
  });
}
```
No changes to existing `MessageCreate` flow. No new `GatewayIntentBits` needed (interactions arrive without intents).

---

## Open Question: Brightdata Profile Dataset

The existing `instagramPost.ts` uses dataset `gd_lk5ns7kz21pck8jpis` (per-post). The monitor needs a **profile** dataset that returns recent posts by username. This dataset ID needs to be confirmed from Brightdata docs or the existing account. Recommend adding `BD_IG_PROFILE_DATASET_ID` as an optional env var (falls back to a default if known).

---

## Verification

1. Create `monitors.json` with a real test channel
2. Set `MONITORS_CONFIG_PATH=./monitors.json` in `.env`
3. Run `bun dev` — confirm monitor config loaded in logs
4. Use `/monitor embed lisa_bp` in the configured channel — confirm embed appears and is pinned
5. Click "Fetch New Posts":
   - Confirm role check (if role set)
   - Confirm cooldown blocks second click
   - Confirm posts appear in all watcher channels
   - Confirm embed updates with new "Last fetched" time
6. Click "Status" — confirm embed refreshes in-place without new message
7. Test both `links` and `inline` formats across different watcher channels
8. Run `bun run typecheck` — no errors
