# Monitor / Fetch Distribution Feature

The Monitor feature provides a semi-automated system designed to track new posts on specific Instagram/TikTok accounts and distribute them across multiple Discord servers simultaneously in a controlled, manual-review fashion. 

Unlike fully automated webhooks that might get blocked or post bad scrapes, this system employs a **Manual Polling & Review Queue** code flow.

## The Configuration Topography

The bot administrator defines connections between social media accounts and Discord configurations entirely in a local JSON config (`MONITORS_CONFIG_PATH`).

```json
{
  "panel_channel_id": "999999999999",
  "socials_channel_id": "888888888888",
  "format": "inline",
  "connections": [
    {
      "type": "instagram",
      "handle": "lisa_bp",
      "cooldown_seconds": 300
    }
  ]
}
```

## Deep Code Flow: Fetching and Reviewing

This entire system spans `src/handlers/monitor/interactions.ts` and `src/handlers/monitor/fetch.ts`. 

### 1. Panel and Cooldown Subsystem
- The bot generates an interactive Status embed (the "Panel") via `/monitor panel setup`. 
- Inside `interactions.ts`, when a user presses a platform button (e.g., `monitor:poll:instagram:lisa_bp`), the bot evaluates `getConnectionMeta` via the SQLite DB.
- If the current time is before the calculated `next_poll_at`, the interaction is rejected with an ephemeral "On cooldown" message.

### 2. Fetching & Seen-Post Filtering
- `fetch.ts` handles the API calls (Brightdata for Instagram, RapidAPI for TikTok).
- The resulting posts are filtered against the local SQLite `seen_posts` table.
- For each **new** post, a `ReviewState` object is created in memory (indexed by a unique `reviewId`).

### 3. The Interactive Review Workflow
Each new post generates a "Review Message" in the panel channel. This message uses **Discord Components V2** (Text Displays and Media Galleries).

#### The State Lifecycle:
1.  **Creation**: `fetch.ts` calls `createReview(state)`, storing buffers and metadata in a `Map` with a 1-hour TTL (Time-To-Live).
2.  **Editing**: 
    - Pressing **"Edit Text"** triggers `handleReviewEdit`, which shows a `ModalBuilder`.
    - Submitting the modal triggers `handleReviewModalSubmit`, which updates the `customContent` in the in-memory state and refreshes the Discord message using `interaction.update()`.
3.  **Image Management**:
    - A `StringSelectMenu` allows users to toggle which images should be removed.
    - `handleReviewRemove` updates the `removedIndices` set in the state. The UI is refreshed, showing the removed images as "spoilers" or hidden in the gallery.
4.  **Finalizing (Post vs. Skip)**:
    - **Skip**: `handleReviewSkip` purges the state and deletes the Discord message.
    - **Post**: `handleReviewPost` executes the distribution logic (uploading to the socials channel, marking as seen in SQLite, and cleaning up memory).

## Interactive UI: Custom ID Prefixes

If you are adding new buttons or modals, you must register a prefix in `src/handlers/monitor/review.ts` and add a case in the `handleInteraction` dispatcher.

| Prefix | Component Type | Handler Function | Purpose |
| :--- | :--- | :--- | :--- |
| `monitor:poll:` | Button | `handlePanelPollButton` | Triggers a fetch for a specific connection. |
| `monitor:review:remove:` | Select Menu | `handleReviewRemove` | Toggles images to exclude from the final post. |
| `monitor:review:edit:` | Button | `handleReviewEdit` | Opens the modal to edit post text. |
| `monitor:review:modal:` | Modal | `handleReviewModalSubmit` | Saves edited text into the review state. |
| `monitor:review:post:` | Button | `handleReviewPost` | Finalizes and distributes the post to socials. |
| `monitor:review:skip:` | Button | `handleReviewSkip` | Discards the post and cleans up state. |

## Database Schema / State tracking

The SQLite database (`data.db`) maintains:
1. `panel_messages`: Tracking where the active panel embed is located.
2. `connection_meta`: Tracking the `last_fetched_at` timestamp and `last_fetched_by` user for cooldowns.
3. `seen_posts`: Caching platform-specific `post_id`s to prevent duplicate distribution.
