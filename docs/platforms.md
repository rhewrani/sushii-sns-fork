# Supported Platforms

The bot is designed with a plugin-like architecture for adding various social media platforms. All platform downloaders live in the `src/platforms/` directory and extend an abstract `SnsDownloader<M>` base class found in `src/platforms/base.ts`.

## The `SnsDownloader` Base Class & The `PostData` Contract

To safely ingest data into Discord, all plugins must compile website content into a standard `PostData` interface:

```typescript
export interface PostData<M extends SnsMetadata> {
  postLink: SnsLink<M>;
  username: string;
  postID: string;
  originalText: string;
  timestamp?: Date;
  files: { ext: string; buffer: Buffer }[]; 
}
```

By returning raw Buffers (`files`), the central handler module ensures the bot manages Discord upload limits globally rather than requiring each platform plugin to write Discord-specific batching code.

Every platform must implement the following core requirements:

1. **`PLATFORM` Identification**: E.g., `"twitter"`, `"instagram"`.
2. **`URL_REGEX`**: A regular expression specific to the platform for finding valid URLs within Discord messages.
3. **`createLinkFromMatch(match)`**: Converts a matched URL into an organized `SnsLink` metadata object.
4. **`fetchContent(snsLink, progressFn)`**: Hits external APIs (Brightdata, RapidAPI, fxtwitter) to fetch metadata and return the array of `PostData`.
5. **Discord Formatters**:
   - `buildDiscordAttachments(postData)`: Splits raw Buffers into Discord `MessageCreateOptions` arrays chunked by Discord's limit (`MAX_ATTACHMENTS_PER_MESSAGE`).
   - `buildDiscordMessages(postData, attachmentURLs)`: Constructs the textual post (injecting the CDN URLs for formatting).

## Platform Implementations & Workflows

### 1. Twitter (X.com)

- **Location**: `src/platforms/twitter/downloader.ts`
- **Workflow**:
  - Matches `x.com/username/status/id` via regex.
  - Builds a request hitting `api.fxtwitter.com` (a third-party scrape-friendly endpoint) instead of the heavily restricted official Twitter API.
  - Parses the `TweetAPIResponse`, extracting the high-res images and MP4 URLs internally.
  - Pushes those URLs into a generic internal buffer downloader (`this.downloadImages()`) and determines the appropriate file extensions based on the `fxtwitter` output.

### 2. Instagram Posts (and Reels)

- **Location**: `src/platforms/instagram-post/downloader.ts`
- **Workflow**:
  - Since Instagram blocks stateless requests natively, the bot relies on **Brightdata** (`api.brightdata.com`).
  - Sends a `trigger` POST request with the Instagram dataset ID.
  - Polls the snapshot endpoint until the scrape is `ready` (up to 120 seconds).
  - Retrieves the scraped item mapping photos and videos, downloads the specific `mediaUrls` to buffers, and automatically converts iOS `.heic` arrays natively into JPEG buffers for Discord compatibility.

### 3. Instagram Stories

- **Location**: `src/platforms/instagram-story/downloader.ts`
- **Workflow**: Identifies story URLs and heavily relies on metadata logic (since stories require distinct API endpoints compared to normal posts) fetching from RapidAPI endpoints (`instagram120.p.rapidapi.com`).

### 4. TikTok

- **Location**: `src/platforms/tiktok/downloader.ts`
- **Workflow**: Handles both standard URLs and shortened `vm.tiktok` links. Utilizes RapidAPI (`tiktok-best-experience.p.rapidapi.com`) to query the exact `aweme_id`, which then provides a direct download link to either the watermarked or watermark-free MP4 address.

## Adding a New Platform

To add a new platform:
1. Create a new folder in `src/platforms/` (e.g., `youtube`).
2. Create `downloader.ts` containing a subclass extending `SnsDownloader<Metadata>`.
3. Provide the regex and implement `buildApiRequest` / `fetchContent`.
4. Register your class instance in the `downloaders` array internally inside `src/handlers/sns.ts`.
