import dayjs from "dayjs";
import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import config from "../../config/config";
import logger from "../../logger";
import { chunkArray, formatDiscordTitle, itemsToMessageContents, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import {
  attachmentMessageContent,
  SnsDownloader,
  type Platform,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type TikTokMetadata,
} from "../base";
import {
  TikTokPostResponseSchema,
  type TikTokPostResponse,
} from "./types";

const log = logger.child({ module: "TikTokDownloader" });

export class TikTokDownloader extends SnsDownloader<TikTokMetadata> {
  PLATFORM: Platform = "tiktok";

  URL_REGEX = new RegExp(
    /https:\/\/(www\.)?tiktok\.com\/@\w+\/video\/(?<id>\d+)/gi,
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<TikTokMetadata> {
    if (!match.groups?.id) {
      throw new Error("No video ID match found");
    }

    return {
      url: match[0],
      metadata: {
        platform: "tiktok",
        videoId: match.groups.id,
      },
    };
  }

  buildApiRequest(details: SnsLink<TikTokMetadata>): Request {
    return new Request(
      `https://tiktok-best-experience.p.rapidapi.com/video/${details.metadata.videoId}`,
      {
        method: "GET",
        headers: {
          "x-rapidapi-host": "tiktok-best-experience.p.rapidapi.com",
          "x-rapidapi-key": config.RAPID_API_KEY,
        },
      },
    );
  }

  async fetchContent(
    snsLink: SnsLink<TikTokMetadata>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<TikTokMetadata>[]> {
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
    let ttPost: TikTokPostResponse;
    try {
      rawJson = await response.json();

      log.debug(
        {
          rawJson,
        },
        "Fetched tiktok video",
      );

      // Throws if invalid
      ttPost = TikTokPostResponseSchema.parse(rawJson);
    } catch (err) {
      log.error(
        {
          err,
          response,
          responseCode: response.status,
          body: rawJson,
        },
        "Failed to parse tiktok API response",
      );

      throw new Error("Failed to parse tiktok JSON response");
    }

    log.debug(
      {
        igStoriesRes: ttPost,
      },
      "Fetched IG stories response",
    );

    if (!ttPost.data || !ttPost.data.aweme_detail?.video?.play_addr?.url_list) {
      throw new Error("No data");
    }

    if (ttPost.data.aweme_detail.video.play_addr.url_list.length === 0) {
      throw new Error("No TikTok videos urls found");
    }

    progressCallback?.(`Downloading tiktoky...`);

    log.debug(
      {
        tiktokVideo: ttPost.data.aweme_detail.video.play_addr?.url_list,
      },
      "Downloading media URLs",
    );

    const url = ttPost.data.aweme_detail.video.play_addr.url_list[1];

    // Only 1 URL
    const buffers = await this.downloadImages([url]);

    const file = {
      ext: "mp4",
      buffer: buffers[0],
    };

    const ts =
      ttPost.data.aweme_detail.create_time &&
      ttPost.data.aweme_detail.create_time * 1000;

    const postData: PostData<TikTokMetadata> = {
      postLink: snsLink,
      username: ttPost.data.aweme_detail.author?.unique_id || "Unknown user",
      postID: snsLink.metadata.videoId,
      originalText: "",
      timestamp: ts ? dayjs(ts).toDate() : undefined,
      files: [file],
    };

    progressCallback?.("Downloaded!", true);

    return [postData];
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<TikTokMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) => {
      let name = `tiktok-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`;

      return new AttachmentBuilder(file.buffer).setName(name);
    });

    // Groups of 10
    const attachmentsChunks = chunkArray(
      attachments,
      MAX_ATTACHMENTS_PER_MESSAGE,
    );

    return attachmentsChunks.map((chunk) => {
      return {
        content: attachmentMessageContent(),
        files: chunk,
      };
    });
  }

  buildDiscordMessages(
    postData: PostData<TikTokMetadata>,
    attachmentURLs: string[],
  ): MessageCreateOptions[] {
    let msgs: MessageCreateOptions[] = [];

    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "tiktok",
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
