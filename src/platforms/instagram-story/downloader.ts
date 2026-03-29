import dayjs from "dayjs";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, KST_TIMEZONE, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import { ApiUsageEndpoint, recordApiUsage } from "../../apiUsage";
import { tryWithFallbacks } from "../../utils/fallback";
import { StoryUnavailableError } from "./errors";
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
import { IgStoriesSchema, type IgStories } from "./types";

const log = logger.child({ module: "InstagramStoryDownloader" });

export class InstagramStoryDownloader extends SnsDownloader<InstagramMetadata> {
  PLATFORM: Platform = "instagram-story";

  URL_REGEX = new RegExp(
    "https?://" +
    "(?:www\\.)?" +
    "instagram\\.com/" +
    "stories/" +
    "([\\w.-]+)" +
    "/" +
    "(\\d+)" +
    "/?" +
    "(?:\\?\\S*)?" +
    "(?:#\\S*)?",
    "gi"
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<InstagramMetadata> {
    const username = match[1];
    const storyId = match[2];

    return {
      url: match[0],
      metadata: {
        platform: "instagram-story",
        username,
        shortcode: storyId, // just use but ist actually the story id
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      `https://instagram120.p.rapidapi.com/api/instagram/story`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "instagram120.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
        body: JSON.stringify({
          username: details.metadata.username,
          storyId: details.metadata.shortcode,
        }),
      },
    );
  }

  private async fetchContentViaRapidApi(
    snsLink: SnsLink<InstagramMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<InstagramMetadata>[]> {
    const req = this.buildApiRequest(snsLink);
    const response = await fetch(req);
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG120_STORY_SINGLE);

    if (response.status !== 200) {
      const body = await response.text();
      log.error(
        {
          request: req.headers,
          responseCode: response.status,
          responseBody: body,
        },
        "Failed to fetch ig API story response",
      );

      throw new StoryUnavailableError(
        "This Instagram story is no longer available. Stories expire after about 24 hours, or the link may be invalid.",
      );
    }

    let igStoriesRes: IgStories;
    let rawJson;
    try {
      const responseText = await response.text();

      rawJson = JSON.parse(responseText);
      igStoriesRes = IgStoriesSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          responseCode: response.status,
          rawBody: rawJson,
        },
        "Failed to parse ig API response",
      );
      throw new StoryUnavailableError(
        "Could not read this Instagram story. It may have expired or been removed.",
      );
    }

    log.debug(
      {
        igStoriesRes,
      },
      "Fetched IG stories response",
    );

    if (!igStoriesRes.result || igStoriesRes.result.length === 0) {
      throw new StoryUnavailableError(
        "No story found at that link. Instagram stories expire after about 24 hours.",
      );
    }

    progressCallback?.(
      `Downloading ${igStoriesRes.result.length} story`,
    );

    // Categorize by date in KST!! Could be multiple stories on different days
    // YYMMDD -> [media URLs]
    const storiesByDate = new Map<string, { date?: Date; urls: string[] }>();

    for (const item of igStoriesRes.result) {
      const takenAtMs = item.taken_at * 1000;
      const d = dayjs(takenAtMs).tz(KST_TIMEZONE);
      const dateKey = d.format("YYMMDD");

      const storiesDay = storiesByDate.get(dateKey) ?? {
        date: new Date(takenAtMs),
        urls: [],
      };

      let mediaUrl: string | undefined;

      if (item.video_versions?.[0]?.url) {
        mediaUrl = item.video_versions[0].url;
      } else if (item.video_url) {
        mediaUrl = item.video_url;
      } else if (item.image_versions2?.candidates?.[0]?.url) {
        mediaUrl = item.image_versions2.candidates[0].url;
      } else if (item.thumbnail_url) {
        mediaUrl = item.thumbnail_url;
      }

      if (mediaUrl) {
        storiesDay.urls.push(mediaUrl);
      } else {
        log.warn({ item, pk: item.pk }, "No extractable media URL for story");
      }

      storiesByDate.set(dateKey, storiesDay);
    }

    const storyUsername = igStoriesRes.result[0]?.user?.username || "Unknown user";
    const postDatas: PostData<InstagramMetadata>[] = [];
    for (const [dateKey, { date, urls }] of storiesByDate.entries()) {
      const buffers = await this.downloadImages(urls);

      let files: File[] = buffers.map((buf, i) => {
        return {
          ext: getFileExtFromURL(urls[i]),
          buffer: buf,
        };
      });

      // Convert any HEIC files to JPEG
      files = await convertHeicToJpeg(files);

      const postData: PostData<InstagramMetadata> = {
        postLink: snsLink,
        username: storyUsername,
        postID: `instagram-story:${storyUsername}:${dateKey}`,
        originalText: "",
        timestamp: date,
        files,
      };

      postDatas.push(postData);
    }

    progressCallback?.("Downloaded!", true);

    return postDatas;
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
        name: "RapidAPI stories",
        fn: () => this.fetchContentViaRapidApi(snsLink, progressCallback),
      },
      // TODO: Add additional fallback provider here
      // { name: "Placeholder", fn: () => ... },
    ]);
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<InstagramMetadata>,
  ): MessageCreateOptions[] {
    const ts = postData.timestamp
      ? dayjs(postData.timestamp).tz(KST_TIMEZONE).format("YYMMDD")
      : null;

    const attachments = postData.files.map((file, i) => {
      let name;
      if (ts) {
        // Has timestamp
        name = `ig-story-${postData.username}-${ts}-${i + 1}.${file.ext}`;
      } else {
        // No timestamp, exclude
        name = `ig-story-${postData.username}-${i + 1}.${file.ext}`;
      }

      return new AttachmentBuilder(file.buffer).setName(name);
    });

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
