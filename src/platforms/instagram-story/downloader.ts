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
    /https?:\/\/(?:www\.)?instagram\.com\/([\w-]{3,})\/$/gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<InstagramMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "instagram-story",
      },
    };
  }

  buildApiRequest(details: SnsLink<InstagramMetadata>): Request {
    return new Request(
      `https://instagram-scraper-api2.p.rapidapi.com/v1/stories?username_or_id_or_url=${encodeURIComponent(details.url)}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "instagram-scraper-api2.p.rapidapi.com",
          "x-rapidapi-key": process.env.RAPID_API_KEY!,
        },
      },
    );
  }

  async fetchContent(
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
        "Failed to fetch ig API story response",
      );

      throw new Error("Failed to fetch ig API story response");
    }

    let rawJson;
    let igStoriesRes: IgStories;
    try {
      rawJson = await response.json();

      // Throws if invalid
      igStoriesRes = IgStoriesSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
          body: rawJson,
        },
        "Failed to parse ig trigger API response",
      );

      throw new Error("Failed to parse ig JSON response");
    }

    log.debug(
      {
        igStoriesRes,
      },
      "Fetched IG stories response",
    );

    if (!igStoriesRes.data || !igStoriesRes.data.items) {
      throw new Error("No data");
    }

    if (igStoriesRes.data.items.length === 0) {
      throw new Error("No Instagram stories found");
    }

    progressCallback?.(
      `Downloading ${igStoriesRes.data.items.length} stories...`,
    );

    // Categorize by date in KST!! Could be multiple stories on different days
    // YYMMDD -> [media URLs]
    const storiesByDate = new Map<string, { date?: Date; urls: string[] }>();

    for (const item of igStoriesRes.data.items) {
      let dateKey = "unknown";
      if (item.taken_at_date) {
        const d = dayjs(item.taken_at_date).tz(KST_TIMEZONE);
        dateKey = d.format("YYMMDD");
      } else {
        log.warn(
          {
            item,
          },
          "No taken_at_date ... bruh",
        );
      }

      // Default value
      const storiesDay = storiesByDate.get(dateKey) ?? {
        date: item.taken_at_date,
        urls: [],
      };

      // Video
      if (item.video_url) {
        storiesDay.urls.push(item.video_url);
      }

      // Otherwise thumbnail image. Video stories also have thumbnail images,
      // so only if video URL is missing
      if (!item.video_url && item.thumbnail_url) {
        storiesDay.urls.push(item.thumbnail_url);
      }

      // Need to set even if array is reference since object isn't set
      storiesByDate.set(dateKey, storiesDay);

      if (!item.video_url && !item.thumbnail_url) {
        log.warn(
          {
            item,
          },
          "No video or thumbnail URL... bruh",
        );
      }
    }

    log.debug(
      {
        stories: storiesByDate,
      },
      "Downloading media URLs",
    );

    const postDatas: PostData<InstagramMetadata>[] = [];
    const storyUsername =
      igStoriesRes.data.additional_data?.user?.username || "Unknown user";
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
