import {
  AttachmentBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from "discord.js";
import logger from "../../../logger";
import { chunkArray, itemsToMessageContents } from "../../util";
import type { TweetAPIResponse } from "./../fxtweet";
import {
  attachmentMessageContent,
  SnsDownloader,
  type Platform,
  type PostData,
  type SnsLink,
  type TwitterMetadata,
} from "./base";
import {
  fetchWithHeaders,
  formatDiscordTitle,
  getFileExtFromURL,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./util";

const log = logger.child({ module: "TwitterDownloader" });

export class TwitterDownloader extends SnsDownloader<TwitterMetadata> {
  PLATFORM: Platform = "twitter";

  URL_REGEX = new RegExp(
    "https?://(?:(?:www|m|mobile)\\.)?" +
      "(?:twitter\\.com|x\\.com)" +
      "/(\\w+)/status/(\\d+)(/(?:photo|video)/\\d)?/?(?:\\?\\S+)?(?:#\\S+)?",
    // 'i' flag for case-insensitivity
    // 'g' flag for global search - makes String.match() exclude capture groups
    "ig",
  );

  protected createLinkFromMatch(
    match: RegExpMatchArray,
  ): SnsLink<TwitterMetadata> {
    return {
      url: match[0],
      metadata: {
        platform: "twitter",
        username: match[1],
        id: match[2],
      },
    };
  }

  buildApiRequest(details: SnsLink<TwitterMetadata>): Request {
    return new Request(
      `https://api.fxtwitter.com/${details.metadata.username}/status/${details.metadata.id}/en`,
      {
        headers: {
          "User-Agent":
            "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns",
        },
      },
    );
  }

  async fetchContent(
    snsLink: SnsLink<TwitterMetadata>,
  ): Promise<PostData<TwitterMetadata>[]> {
    const req = this.buildApiRequest(snsLink);
    const response = await fetchWithHeaders(req);

    let tweetRes: TweetAPIResponse;
    try {
      tweetRes = await response.json();
    } catch (err) {
      log.error(
        {
          err,
          req,
        },
        "Failed to parse tweet API response from",
      );
      throw new Error("Failed to parse tweet JSON response");
    }

    if (tweetRes.code !== 200) {
      throw new Error("Failed to fetch tweet: " + tweetRes.message);
    }

    if (!tweetRes.tweet) {
      throw new Error("Tweet not found: " + tweetRes.message);
    }

    const media = tweetRes.tweet.media.all;

    if (!media) {
      throw new Error("No media found in tweet");
    }

    const buffers = await this.downloadImages(media.map((m) => m.url));

    const files = buffers.map((buf, i) => {
      return {
        ext: getFileExtFromURL(media[i].url),
        buffer: buf,
      };
    });

    return [
      {
        postLink: snsLink,
        username: tweetRes.tweet.author.screen_name,
        postID: tweetRes.tweet.id,
        originalText: tweetRes.tweet.text,
        translatedText: tweetRes.tweet.translation?.text,
        translatedFromLang: tweetRes.tweet.translation?.source_lang_en,
        timestamp: new Date(tweetRes.tweet.created_timestamp * 1000),
        files,
      },
    ];
  }

  // Needs to be separate so we can get the Discord attachment URLs
  buildDiscordAttachments(
    postData: PostData<TwitterMetadata>,
  ): MessageCreateOptions[] {
    const attachments = postData.files.map((file, i) =>
      new AttachmentBuilder(file.buffer).setName(
        `twitter-${postData.username}-${postData.postID}-${i + 1}.${file.ext}`,
      ),
    );

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
    postData: PostData<TwitterMetadata>,
    attachmentURLs: string[],
  ): MessageCreateOptions[] {
    let msgs: MessageCreateOptions[] = [];

    // Formatted post
    let mainPostContent = "";
    mainPostContent += formatDiscordTitle(
      "twitter",
      postData.username,
      postData.timestamp,
    );
    mainPostContent += "\n";
    mainPostContent += `<https://x.com/${postData.username}/status/${postData.postID}>`;
    mainPostContent += "\n";

    // Image URLs can be span multiple messages
    const imageUrlsChunks = itemsToMessageContents(
      mainPostContent,
      attachmentURLs,
    );

    const imageMsgs: MessageCreateOptions[] = imageUrlsChunks.map((chunk) => ({
      content: chunk,
      // Prevent embeds
      flags: MessageFlags.SuppressEmbeds,
    }));

    msgs.push(...imageMsgs);
    return msgs;
  }
}
