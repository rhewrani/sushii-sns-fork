# Bot Commands

Sushii-SNS features two main ways to interact with it: message-based commands for downloading media, and slash commands for the Instagram Monitor feature.

## 1. The `dl` Keyword Download

To trigger the bot to download media from a supported platform, you must send a message starting with the keyword `dl` followed by the URL(s) you wish to process.

**Syntax:**
```text
dl [URL]
```

**Examples:**
```text
dl https://twitter.com/user/status/123456789
dl https://www.instagram.com/p/C123456/
dl https://www.tiktok.com/@user/video/123456789
```

**How it works:**
1. The bot listens to all messages in the server where it has permissions.
2. If it detects `dl` at the start, it scans the message content for matching platform URLs using its internal list of `SnsDownloader` plugins.
3. It validates the URLs, downloads the high-quality media (bypassing normal platform embed restrictions), and sends the media directly into the channel as attachments.
4. The bot attaches emojis as status reactions (e.g., a thumbs-up when detected) and edits an intermediate "Typing..." / "Downloading..." message during fetching.

## 2. Instagram Monitor Commands

To manage the automated Instagram post distribution fetching, the bot uses native Discord slash commands.

**Slash Command:**
```text
/monitor embed [username]
```

- **Description:** Posts an interactive status embed in the channel for a specific Instagram username.
- **Permissions:** Restricted to users with the `ManageGuild` permission (Server Admins).
- **Usage:**
  - `username`: The exact Instagram username you have configured the bot to watch (via `monitors.json`).
  - The channel you run this command in **must** be listed as a watcher for that username in the configuration.
- **What it does:**
  It creates (and pins) an interactive embed showing the current fetch status, along with buttons to manually "Fetch New Posts" or check the status. 

For full details on configuring and running the Monitor, see [monitor-feature.md](./monitor-feature.md).
