# Plan B: Instagram Monitor Feature

## Context
Add semi-automated Instagram monitoring. Community members press "Fetch New Posts" on a pinned Discord embed; the bot fetches recent posts via the same Brightdata Web Scraper API as the existing instagram-post downloader (same dataset ID `gd_lk5ns7kz21pck8jpis`, profile URL as payload) and distributes to all configured watcher channels. Deduplication via SQLite prevents reposting seen posts.

**Prerequisite**: Plan A (Templating System) must be implemented first.

Template resolution order for a watcher:
1. Watcher-level `template` in `monitors.json` (most specific)
2. Guild-level template from `server_config.json`
3. Platform default (`DEFAULT_LINKS_TEMPLATE` / `DEFAULT_INLINE_TEMPLATE`)

---

## New Files

```
src/handlers/monitor/
  config.ts        Zod schema + loadMonitorsConfig()
  db.ts            bun:sqlite open() + typed query helpers
  embed.ts         buildStatusEmbed() → { embeds, components }
  fetch.ts         fetchIgProfilePosts(), postLinksFormat(), postInlineFormat(),
                   fetchAndPost(), updateAllEmbeds()
  interactions.ts  handleInteraction(): routes buttons + slash command
  commands.ts      registerSlashCommands() via discord.js REST
```

---

## Modified Files

### `src/config/config.ts`
```typescript
MONITORS_CONFIG_PATH: z.string().optional(),
MONITORS_DB_PATH: z.string().optional().default("./monitors.db"),
```

### `src/index.ts`
```typescript
if (config.MONITORS_CONFIG_PATH) {
  const monitorsConfig = loadMonitorsConfig(config.MONITORS_CONFIG_PATH);
  const monitorDb = openDb(config.MONITORS_DB_PATH);
  await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(interaction, client, monitorsConfig, monitorDb);
  });

  log.info({ subscriptions: monitorsConfig.subscriptions.length }, "Monitor feature enabled");
}
```

---

## `config.ts`

```typescript
export const WatcherSchema = z.object({
  guild_id: z.string(),
  channel_id: z.string(),
  format: z.enum(["links", "inline"]),
  allowed_role_id: z.string().nullable(),
  template: z.string().optional(),  // overrides guild-level template
});

export const SubscriptionSchema = z.object({
  ig_username: z.string(),
  fetch_cooldown_seconds: z.number(),
  watchers: z.array(WatcherSchema),
});

export const MonitorsConfigSchema = z.object({
  subscriptions: z.array(SubscriptionSchema),
});
```

---

## `db.ts`

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
  last_fetched_by TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_seen_posts (
  ig_username TEXT    NOT NULL,
  post_id     TEXT    NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (ig_username, post_id)
);
```

`PRAGMA journal_mode=WAL`. Exports: `openDb`, `getLastFetch`, `upsertLastFetch`, `isPostSeen`, `markPostSeen`, `getMonitorMessage`, `upsertMonitorMessage`.

---

## `embed.ts`

`buildStatusEmbed(igUsername, cooldownSeconds, lastFetch)` → `{ embeds, components }`:
- `EmbedBuilder` color `0xE1306C`, title `📸 Instagram Monitor: @{igUsername}`
- "Last fetched" field: `<t:X:R>` + display name, or "Never"
- "Next fetch available" field: `<t:X:R>` or "Now" if cooldown elapsed
- Buttons: `monitor:fetch:{ig_username}` (Primary, 📥 Fetch New Posts), `monitor:status:{ig_username}` (Secondary, ℹ️ Status)

---

## `fetch.ts`

**`fetchIgProfilePosts(igUsername)`**:
1. `POST /datasets/v3/trigger?dataset_id=gd_lk5ns7kz21pck8jpis&include_errors=true` with `[{ url: "https://www.instagram.com/{igUsername}/" }]` — same dataset ID as post downloader, profile URL as payload
2. Parse via `BdTriggerResponseSchema` → `snapshot_id`
3. `new InstagramPostDownloader().waitUntilDataReady(snapshotId)` — reuse existing poll loop
4. `fetchAllSnapshotPosts(snapshotId)` — same 5-retry logic as `fetchSnapshotData` but returns all `InstagramPostElement[]` via `InstagramPostListSchema` (not just `[0]`)

**`postLinksFormat(channel, postData, template)`**:
- Send `downloader.buildDiscordAttachments(postData)` → collect CDN URLs
- Call `buildLinksFormatMessages(template, postData, cdnUrls)` from Plan A
- Send each message

**`postInlineFormat(channel, postData, template)`**:
- `buildInlineFormatContent(template, postData)` → content string
- Build `AttachmentBuilder[]` from `postData.files`
- Chunk with `chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE)`, content on first chunk only, `MessageFlags.SuppressEmbeds`

**`fetchAndPost(interaction, client, monitorsConfig, serverConfig, monitorDb)`**:
1. `deferReply({ ephemeral: true })`
2. Identify watcher by `interaction.channelId`; role check via `allowed_role_id`
3. Cooldown check via `getLastFetch()` — reply with `<t:X:R>` if blocked
4. `editReply("Fetching...")`
5. `fetchIgProfilePosts(igUsername)` → filter via `isPostSeen()`
6. For each new post: download media + `convertHeicToJpeg()`, build `PostData`, resolve template (watcher → guild → default), distribute to all watchers
7. `markPostSeen()`, `upsertLastFetch()`, `updateAllEmbeds()`
8. `editReply("Done! Posted N new posts.")` or `"No new posts found."`

**`updateAllEmbeds`**: for each watcher, `getMonitorMessage()` → fetch channel + message → edit with `buildStatusEmbed()`. Warn and skip if message was deleted (DiscordAPIError 10008).

---

## `interactions.ts`

- Button `monitor:fetch:{ig_username}` → `fetchAndPost()`
- Button `monitor:status:{ig_username}` → `deferUpdate()`, rebuild embed, edit `interaction.message` in-place
- Slash command `/monitor embed {username}`:
  - Verify `ManageGuild` permission (double-checked in handler)
  - Verify current channel is a configured watcher
  - Check existing `message_id` in DB → try to edit; on DiscordAPIError 10008 fall through to post new
  - Post embed, pin, `upsertMonitorMessage()`

---

## `commands.ts`

```typescript
new SlashCommandBuilder()
  .setName("monitor")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName("embed")
       .addStringOption(opt => opt.setName("username").setRequired(true))
  )
// Registered globally via REST.put(Routes.applicationCommands(appId))
```

---

## Reused Utilities

| Utility | Source |
|---------|--------|
| `renderTemplate`, `buildTemplateVars`, `buildLinksFormatMessages`, `buildInlineFormatContent` | `src/utils/template.ts` (Plan A) |
| `getGuildTemplate` | `src/config/server_config.ts` (Plan A) |
| `DEFAULT_LINKS_TEMPLATE`, `DEFAULT_INLINE_TEMPLATE` | `src/utils/template.ts` (Plan A) |
| `chunkArray`, `MAX_ATTACHMENTS_PER_MESSAGE`, `KST_TIMEZONE` | `src/utils/discord.ts` |
| `InstagramPostDownloader.waitUntilDataReady()`, `.buildDiscordAttachments()` | `src/platforms/instagram-post/downloader.ts` |
| `InstagramPostListSchema`, `BdTriggerResponseSchema` | `src/platforms/instagram-post/types.ts` |
| `convertHeicToJpeg()` | `src/utils/heic.ts` |
| `getFileExtFromURL()` | `src/utils/http.ts` |

---

## Example `monitors.json`

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
          "allowed_role_id": null,
          "template": "{date_kst} {username} Instagram\n<{post_url}>\n{links}"
        }
      ]
    }
  ]
}
```

---

## Verification

### Plan A
1. No `server_config.json` → `dl` output identical to today
2. Add config with custom guild template → output matches template
3. `bun run typecheck` — no errors

### Plan B
1. Set `MONITORS_CONFIG_PATH=./monitors.json`, `bun dev` → "Monitor feature enabled" log
2. `/monitor embed lisa_bp` → embed posts, pinned, DB row created
3. Click "Fetch New Posts": role check denial, cooldown block on second click, posts in all watcher channels, embed updates with new timestamp + display name
4. Click "Status" → embed refreshes in-place, no new message
5. Delete pinned embed, `/monitor embed` again → new embed
6. Test watcher with custom `template` vs default, and `inline` vs `links` format
7. `bun run typecheck` — no errors
