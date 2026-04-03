# Monitor / fetch / review feature

The monitor tracks configured social connections (Instagram, TikTok, Twitter), lets staff **poll** for new items, and routes them through a **manual review** queue before posting to a designated “socials” channel.

## Configuration (`MONITORS_CONFIG_PATH`)

Connections are declared in JSON (not the older per-subscription-only model). Example shape:

```json
{
  "panel_channel_id": "CHANNEL_ID",
  "socials_channel_id": "CHANNEL_ID",
  "format": "inline",
  "template": "",
  "connections": [
    {
      "type": "instagram",
      "handle": "username",
      "igId": "NUMERIC_IG_USER_ID",
      "cooldown_seconds": 300
    }
  ]
}
```

- **`panel_channel_id`**: Where the status embed and poll buttons live.
- **`socials_channel_id`**: Destination for approved posts (`/post` and review **Post**).
- **`connections`**: Each entry gets a stable id like `instagram:handle` used for SQLite and poll button `customId`s.

## Code map

| Concern | Files |
|--------|--------|
| Poll → fetch → reviews | [`fetch.ts`](../src/handlers/monitor/fetch.ts) (large: feeds, APIs, review message creation) |
| Slash + button dispatch | [`interactions.ts`](../src/handlers/monitor/interactions.ts) |
| Panel embed & poll button | [`interactionPanel.ts`](../src/handlers/monitor/interactionPanel.ts) |
| `/post` & duplicate confirmation | [`interactionPost.ts`](../src/handlers/monitor/interactionPost.ts) |
| Review UI (edit / post / skip) | [`interactionReview.ts`](../src/handlers/monitor/interactionReview.ts) |
| Ephemeral review state | [`review.ts`](../src/handlers/monitor/review.ts) |
| Serialized post jobs | [`queue.ts`](../src/handlers/monitor/queue.ts) |
| Persistence | [`db.ts`](../src/handlers/monitor/db.ts), [`schema.ts`](../src/handlers/monitor/schema.ts) |

## Flow (short)

1. **Panel** — `/monitor panel setup` (in `panel_channel_id`) posts/pins the embed; buttons use prefix `monitor:poll:` + connection id.
2. **Cooldown** — [`getConnectionMeta`](../src/handlers/monitor/db.ts) vs `cooldown_seconds` on the connection.
3. **Fetch** — [`fetchConnectionAndCreateReviews`](../src/handlers/monitor/fetch.ts) pulls new items, marks seen in `monitor_seen_posts`, creates review messages (Components V2).
4. **Post from review** — [`handleReviewPost`](../src/handlers/monitor/interactionReview.ts) enqueues [`sendPostToChannel`](../src/utils/discord.ts) via [`enqueuePost`](../src/handlers/monitor/queue.ts).

## Custom ID prefixes

Defined in [`review.ts`](../src/handlers/monitor/review.ts). Add new prefixes there and handle them in [`interactions.ts`](../src/handlers/monitor/interactions.ts).

| Prefix | Handler (implementation module) |
|--------|----------------------------------|
| `monitor:poll:` | `handlePanelPollButton` — [`interactionPanel.ts`](../src/handlers/monitor/interactionPanel.ts) |
| `monitor:review:remove:` | `handleReviewRemove` — [`interactionReview.ts`](../src/handlers/monitor/interactionReview.ts) |
| `monitor:review:edit:` | `handleReviewEdit` |
| `monitor:review:modal:` | `handleReviewModalSubmit` |
| `monitor:review:post:` | `handleReviewPost` |
| `monitor:review:skip:` | `handleReviewSkip` |

## Database

- **Metadata DB** (`DB_PATH`, default `./data.db`): panel message pointer, connection-level last fetch, and **`monitor_seen_posts`** (`connection_id`, `post_id`, `seen_at`, `posted_message_id`) for deduplication and posted-message tracking.

Ops alerts for serious failures use [`opsAlert.ts`](../src/utils/opsAlert.ts) (`ALERT_DISCORD_USER_ID` optional).
