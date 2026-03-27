import {
  sleep,
} from "bun";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import { buildLinksFormatMessages } from "../../utils/template";
import {
  SnsDownloader,
  SnsUnavailableError,
  type File,
  type InstagramMetadata,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
} from "../base";
import {
  BdMonitorResponseSchema,
  BdScrapeResponseSchema,
  InstagramPostListSchema,
  type InstagramPostElement,
} from "./types";

const log = logger.child({ module: "InstagramPostDownloader" });

const BD_SCRAPE_URL =
  "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_lk5ns7kz21pck8jpis&notify=false&include_errors=true";

export class InstagramPostDownloader extends SnsDownloader<InstagramMetadata> {
  PLATFORM: Platform = "instagram";

  URL_REGEX = new RegExp(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:([\w.]+)\/reels?\/|(?:p|reels?|tv)\/)([\w-]+)\//gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<InstagramMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "instagram",
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(BD_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
      },
      body: JSON.stringify({ input: [{ url: details.url }] }),
    });
  }

  /**
   * Poll /progress until the snapshot is ready, then fetch /snapshot.
   * Used when /scrape returns 202.
   */
  async waitAndFetch(snapshotId: string, timeoutMs = 60_000): Promise<InstagramPostElement[]> {
    const cancelAt = Date.now() + timeoutMs;

    // Poll progress
    while (true) {
      const res = await fetch(
        `https://api.brightdata.com/datasets/v3/progress/${snapshotId}`,
        { headers: { Authorization: `Bearer ${process.env.BD_API_TOKEN!}` } },
      );

      if (res.status === 404 || res.status !== 200) {
        if (Date.now() > cancelAt) throw new Error("IG API timed out waiting for snapshot");
        await sleep(1000);
        continue;
      }

      const progress = BdMonitorResponseSchema.parse(await res.json());
      if (progress.status === "failed") throw new Error("IG API failed to process the post");
      if (progress.status === "ready") break;

      if (Date.now() > cancelAt) throw new Error("IG API timed out waiting for snapshot");
      await sleep(1000);
    }

    // Fetch snapshot data
    for (let i = 0; i < 5; i++) {
      const res = await fetch(
        `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
        { headers: { Authorization: `Bearer ${process.env.BD_API_TOKEN!}` } },
      );

      if (res.status === 202) {
        await sleep(3000);
        continue;
      }

      if (!res.ok) {
        log.error({ responseCode: res.status, responseBody: await res.text() }, "Failed to fetch IG snapshot");
        await sleep(3000);
        continue;
      }

      return InstagramPostListSchema.parse(await res.json());
    }

    throw new Error("Failed to fetch IG snapshot after 5 tries");
  }

  async fetchContent(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    progressCallback?.("Downloading images...");

    const req = this.buildApiRequest(snsLink);
    const response = await fetch(req);

    let posts: InstagramPostElement[];

    if (response.status === 200) {
      // Synchronous response — single URL input returns an object, multiple returns an array
      const rawJson = await response.json();
      const arr = Array.isArray(rawJson) ? rawJson : [rawJson];
      posts = InstagramPostListSchema.parse(arr);
    } else if (response.status === 202) {
      // Async response — poll until ready
      const body = BdScrapeResponseSchema.parse(await response.json());
      if (!body.snapshot_id) throw new Error("No snapshot_id in 202 response");

      log.debug({ snapshotId: body.snapshot_id }, "IG scrape async, polling...");
      progressCallback?.("Waiting for IG data...");
      posts = await this.waitAndFetch(body.snapshot_id);
    } else {
      log.error({ responseCode: response.status, responseBody: await response.text() }, "Failed to fetch ig API response");
      throw new Error(`Failed to fetch ig API response: ${response.status}`);
    }

    if (posts.length === 0) {
      throw new Error("No Instagram posts found");
    }

    const igPost = posts[0];
    log.debug({ response: igPost }, "Downloaded and parsed IG API response");

    if (igPost.error) {
      throw new SnsUnavailableError(igPost.error);
    }

    const { urls: mediaUrls, thumbnailOnly } = extractMediaUrls(igPost);
    if (mediaUrls.length === 0) {
      throw new Error(
        "No media found for this Instagram post — Brightdata did not return image/video URLs. Try again or download manually.",
      );
    }

    log.debug({ mediaUrls: mediaUrls.length }, "Downloading media URLs");

    const buffers = await this.downloadImages(mediaUrls);

    let files = buffers.map((buf, i): File => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    }));

    files = await convertHeicToJpeg(files);

    progressCallback?.("Downloaded!", true);

    return [
      {
        postLink: {
          ...snsLink,
          url: igPost.url ?? snsLink.url,
        },
        username: igPost.user_posted || "Unknown user",
        postID: igPost.post_id || "Unknown ID",
        originalText: igPost.description || "",
        timestamp: igPost.timestamp,
        files,
        thumbnailOnly,
      },
    ];
  }

  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `ig-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`,
      ),
    );

    const attachmentsChunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);

    return attachmentsChunks.map((chunk) => ({
      content: "",
      files: chunk,
    }));
  }

  buildDiscordMessages(
    postData: PostData<InstagramMetadata>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[] {
    if (template) {
      return buildLinksFormatMessages(template, postData, attachmentURLs);
    }

    let mainPostContent = "";
    if (postData.thumbnailOnly) {
      mainPostContent += "⚠️ Only a cropped square thumbnail was available for this post (Brightdata limitation for single-image posts). The full image may be cut off.\n";
    }
    mainPostContent += formatDiscordTitle("instagram", postData.username, postData.timestamp);
    mainPostContent += "\n";
    mainPostContent += `<${postData.postLink.url}>`;
    mainPostContent += "\n";

    const msgChunkContents = itemsToMessageContents(mainPostContent, attachmentURLs);

    return msgChunkContents.map((chunk) => ({
      content: chunk,
      flags: MessageFlags.SuppressEmbeds,
    }));
  }
}

/**
 * Extract media URLs from an Instagram post element.
 * Prefers post_content; falls back to top-level videos/images arrays
 * (Brightdata changed format — post_content is now empty, media is in videos/images).
 */
export type ExtractedMedia = {
  urls: string[];
  thumbnailOnly: boolean;
};

export function extractMediaUrls(igPost: InstagramPostElement): ExtractedMedia {
  // post_content: structured array with type+url (most reliable, preserves order)
  if (igPost.post_content && igPost.post_content.length > 0) {
    const urls = igPost.post_content.map((m) => m.url).filter((x): x is string => !!x);
    if (urls.length > 0) return { urls, thumbnailOnly: false };
  }

  // photos: flat string array for image posts
  if (igPost.photos && igPost.photos.length > 0) {
    const urls = igPost.photos.filter((x): x is string => !!x);
    if (urls.length > 0) return { urls, thumbnailOnly: false };
  }

  // videos: flat string array for video posts
  if (igPost.videos && igPost.videos.length > 0) {
    const urls = igPost.videos.filter((x): x is string => !!x);
    if (urls.length > 0) return { urls, thumbnailOnly: false };
  }

  // images: array of objects (may duplicate post_content but useful as fallback)
  if (igPost.images && igPost.images.length > 0) {
    const urls = igPost.images.map((m) => m.url).filter((x): x is string => !!x);
    if (urls.length > 0) return { urls, thumbnailOnly: false };
  }

  // Last resort: thumbnail — Brightdata only returns a square-cropped 1080px version
  // for single-image feed posts. Flag it so callers can warn the user.
  if (igPost.thumbnail) {
    return { urls: [igPost.thumbnail], thumbnailOnly: true };
  }

  return { urls: [], thumbnailOnly: false };
}
