import { sleep } from "bun";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { tryWithFallbacks } from "../../utils/fallback";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import { buildLinksFormatMessages } from "../../utils/template";
import {
  SnsDownloader,
  type File,
  type InstagramMetadata,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
} from "../base";
import {
  BdMonitorResponseSchema,
  BdTriggerResponseSchema,
  type BdMonitorResponse,
  type BdTriggerResponse,
  InstagramPostListSchema,
  RapidApiMediaResponseSchema,
  type InstagramPostElement,
  type RapidApiMediaResponse,
} from "./types";

const log = logger.child({ module: "InstagramPostDownloader" });

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
        shortcode: match[2],
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      "https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_lk5ns7kz21pck8jpis&include_errors=true",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
        },
        body: JSON.stringify([{ url: details.url }]),
      },
    );
  }

  async waitUntilDataReady(snapshotID: string, timeoutMs = 30_000): Promise<void> {
    const req = new Request(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotID}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
        },
      },
    );

    let cancelAt = Date.now() + timeoutMs;

    let resParsed: BdMonitorResponse;
    while (true) {
      const res = await fetch(req);

      // Might be too fast, retry at least 5 times
      if (res.status === 404) {
        if (Date.now() > cancelAt) {
          log.error(
            {
              requestURL: res.url,
              responseCode: res.status,
              responseBody: await res.text(),
            },
            "Failed to fetch ig API snapshot response",
          );

          throw new Error("Failed to fetch ig API response within 30 seconds");
        }

        // Wait a bit
        await sleep(500);

        continue;
      }

      if (res.status !== 200) {
        log.error(
          {
            responseCode: res.status,
            responseBody: await res.text(),
          },
          "Failed to fetch ig API snapshot response",
        );

        throw new Error(`Failed to fetch ig API response: ${res.status}`);
      }

      const resJson = await res.json();

      resParsed = BdMonitorResponseSchema.parse(resJson);
      if (resParsed.status === "failed") {
        log.error(
          {
            resParsed,
          },
          "IG API failed to process the post",
        );

        throw new Error("IG API failed to process the post");
      }

      // Done, break loop
      if (resParsed.status === "ready") {
        break;
      }

      // Still processing ("starting" / "running") — wait before retrying
      if (Date.now() > cancelAt) {
        throw new Error("IG API timed out waiting for snapshot to be ready");
      }

      await sleep(1000);
    }
  }

  async fetchAllSnapshotData(snapshotID: string): Promise<InstagramPostElement[]> {
    // 5 retries
    for (let i = 0; i < 5; i++) {
      const req = new Request(
        `https://api.brightdata.com/datasets/v3/snapshot/${snapshotID}?format=json`,
        {
          headers: {
            Authorization: `Bearer ${process.env.BD_API_TOKEN!}`,
          },
        },
      );

      const response = await fetch(req);

      // Might be too fast, "Snapshot is building, try again in 30s"
      if (response.status === 202) {
        log.debug(
          {
            requestURL: req.url,
            responseCode: response.status,
            responseBody: await response.text(),
          },
          "IG API snapshot is still building",
        );

        // Retry in 3 seconds
        await sleep(3 * 1000);
        continue;
      }

      if (response.status !== 200) {
        log.error(
          {
            responseCode: response.status,
            responseBody: await response.text(),
          },
          "Failed to fetch ig API snapshot response",
        );

        await sleep(3 * 1000);
        continue;
      }

      try {
        const rawJson = await response.json();
        return InstagramPostListSchema.parse(rawJson);
      } catch (err) {
        log.error(
          {
            err,
            response,
            responseCode: response.status,
          },
          "Failed to parse ig API snapshot response",
        );

        throw err;
      }
    }

    throw new Error("Failed to fetch ig API response after 5 tries");
  }

  async fetchSnapshotData(snapshotID: string): Promise<InstagramPostElement> {
    const posts = await this.fetchAllSnapshotData(snapshotID);
    if (posts.length === 0) {
      throw new Error("No Instagram posts found");
    }
    return posts[0];
  }

  // ---------------------------------------------------------------------------
  // RapidAPI provider: mediaByShortcode
  // ---------------------------------------------------------------------------

  private async fetchContentViaRapidApi(
    snsLink: SnsLink<InstagramMetadata>,
  ): Promise<PostData<InstagramMetadata>[]> {
    const shortcode = snsLink.metadata.shortcode;
    if (!shortcode) {
      throw new Error("No shortcode available for RapidAPI fetch");
    }

    const req = new Request(
      "https://instagram120.p.rapidapi.com/api/instagram/mediaByShortcode",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "instagram120.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
        body: JSON.stringify({ shortcode }),
      },
    );

    const response = await fetch(req);
    if (!response.ok) {
      throw new Error(
        `RapidAPI mediaByShortcode failed (${response.status})`,
      );
    }

    const rawJson = await response.json();
    const items = RapidApiMediaResponseSchema.parse(rawJson);

    if (items.length === 0) {
      throw new Error("RapidAPI returned no media items");
    }

    // All items in the array share the same meta (carousel images)
    const meta = items[0].meta;

    // Collect all media URLs from every item (carousel support)
    const mediaUrls = items
      .flatMap((item) => item.urls.map((u) => u.url))
      .filter((u) => u.length > 0);

    if (mediaUrls.length === 0) {
      throw new Error("RapidAPI returned no media URLs");
    }

    const buffers = await this.downloadImages(mediaUrls);
    let files = buffers.map((buf, i): File => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    }));
    files = await convertHeicToJpeg(files);

    return [
      {
        postLink: {
          ...snsLink,
          url: meta.sourceUrl ?? snsLink.url,
        },
        username: meta.username || "Unknown user",
        postID: meta.shortcode || shortcode,
        originalText: meta.title || "",
        timestamp: meta.takenAt
          ? new Date(meta.takenAt * 1000)
          : undefined,
        files,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Brightdata provider (existing trigger/poll/snapshot)
  // ---------------------------------------------------------------------------

  private async fetchContentViaBrightdata(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const req = this.buildApiRequest(snsLink);
    const response = await fetch(req);

    if (response.status !== 200) {
      log.error(
        {
          request: req.headers,
          responseCode: response.status,
          responseBody: await response.text(),
        },
        "Failed to fetch ig API response",
      );

      throw new Error("Failed to fetch ig API response");
    }

    let triggerResponse: BdTriggerResponse;
    try {
      const rawJson = await response.json();
      triggerResponse = BdTriggerResponseSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
        },
        "Failed to parse ig trigger API response",
      );

      throw new Error("Failed to parse ig JSON response");
    }

    if (!triggerResponse.snapshot_id) {
      throw new Error("Instagram snapshot ID not found");
    }

    progressCallback?.("Waiting for IG data...");
    log.debug(
      { snapshotID: triggerResponse.snapshot_id },
      "Waiting for IG API to process the post",
    );
    await this.waitUntilDataReady(triggerResponse.snapshot_id);

    log.debug(
      { snapshotID: triggerResponse.snapshot_id },
      "IG API processed the post, downloading data...",
    );

    progressCallback?.("Downloading images...");

    const igPost = await this.fetchSnapshotData(triggerResponse.snapshot_id);

    if (!igPost.post_content || igPost.post_content.length === 0) {
      throw new Error("No Instagram post content found");
    }

    const mediaUrls = igPost.post_content
      .map((m) => m.url)
      .filter((x): x is string => !!x);

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
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Public fetchContent — tries providers with fallbacks
  // ---------------------------------------------------------------------------

  async fetchContent(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    return tryWithFallbacks([
      {
        name: "RapidAPI mediaByShortcode",
        fn: () => this.fetchContentViaRapidApi(snsLink),
      },
      // {
      //   name: "Brightdata",
      //   fn: () => this.fetchContentViaBrightdata(snsLink, progressCallback),
      // },
      // TODO: Add additional fallback provider here
      // { name: "Placeholder", fn: () => ... },
    ]);
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `ig-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`,
      ),
    );

    // Groups of 10
    const attachmentsChunks = chunkArray(
      attachments,
      MAX_ATTACHMENTS_PER_MESSAGE,
    );

    return attachmentsChunks.map((chunk) => {
      return {
        content: "",
        files: chunk,
      };
    });
  }

  buildDiscordMessages(
    postData: PostData<InstagramMetadata>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[] {
    if (template) {
      return buildLinksFormatMessages(template, postData, attachmentURLs);
    }

    let msgs: MessageCreateOptions[] = [];

    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "instagram",
      postData.username,
      postData.timestamp,
    );
    mainPostContent += "\n";
    mainPostContent += `<${postData.postLink.url}>`;
    mainPostContent += "\n";

    // Image URLs can be span multiple messages
    const msgChunkContents = itemsToMessageContents(
      mainPostContent,
      attachmentURLs,
    );

    const msgChunks: MessageCreateOptions[] = msgChunkContents.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));

    msgs.push(...msgChunks);
    return msgs;
  }
}
