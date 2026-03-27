import { type MessageCreateOptions } from "discord.js";
import logger from "../logger";

const log = logger.child({ module: "SnsDownloader" });

export type Platform = "twitter" | "instagram" | "instagram-story" | "tiktok";

export function platformToString(platform: Platform): string {
  switch (platform) {
    case "twitter":
      return "Twitter";
    case "instagram":
      return "Instagram";
    case "instagram-story":
      return "Instagram";
    case "tiktok":
      return "TikTok";
  }
}

// Generic interfaces to make the downloader more flexible
export interface SnsMetadata {
  // Base interface for platform-specific metadata
  platform: Platform;
}

export interface TwitterMetadata extends SnsMetadata {
  platform: "twitter";
  username: string;
  id: string;
}

export interface InstagramMetadata extends SnsMetadata {
  platform: "instagram" | "instagram-story";
}

export interface TikTokMetadata extends SnsMetadata {
  platform: "tiktok";
  videoId: string;
}

export type AnySnsMetadata =
  | TwitterMetadata
  | InstagramMetadata
  | TikTokMetadata;

// Define type guard functions for each metadata type
export function isTwitterMetadata(
  metadata: AnySnsMetadata,
): metadata is TwitterMetadata {
  return metadata.platform === "twitter";
}

export function isInstagramMetadata(
  metadata: AnySnsMetadata,
): metadata is InstagramMetadata {
  return (
    metadata.platform === "instagram" || metadata.platform === "instagram-story"
  );
}

// --------------------------------------------------------------------------

// Enhanced details of a link
export type SnsLink<M extends SnsMetadata> = {
  metadata: M;
  url: string;
};

export interface File {
  ext: string;
  buffer: Buffer;
}

// Actual details and files of a post
export interface PostData<M extends SnsMetadata> {
  postLink: SnsLink<M>;
  username: string;
  postID: string;
  originalText: string;
  translatedText?: string;
  translatedFromLang?: string;
  timestamp?: Date;
  files: File[];
  /** True when only a square-cropped thumbnail was available (Brightdata limitation for single-image posts) */
  thumbnailOnly?: boolean;
}

// --------------------------------------------------------------------------
export type ProgressFn = (message: string, done?: boolean) => Promise<void>;

export abstract class SnsDownloader<M extends SnsMetadata> {
  abstract readonly PLATFORM: Platform;

  /**
   * Regular expression to match platform-specific URLs
   * Implemented by child classes
   */
  protected abstract readonly URL_REGEX: RegExp;

  /**
   * Extract platform-specific post details from content
   * @param content Text to search for platform URLs
   * @returns Array of platform-specific post details
   */
  findUrls(content: string): SnsLink<M>[] {
    const matches = content.matchAll(this.URL_REGEX);
    const results: SnsLink<M>[] = [];

    for (const match of matches) {
      results.push(this.createLinkFromMatch(match));
    }

    log.debug(
      {
        content,
        results,
      },
      "Finding URLs in content",
    );

    return results;
  }

  /**
   * Abstract method to create a post object from regex match
   * @param match Regex match result
   * @returns Platform-specific post object
   */
  protected abstract createLinkFromMatch(match: RegExpMatchArray): SnsLink<M>;

  /**
   * Build API fetch request using the extracted details.
   */
  abstract buildApiRequest(details: SnsLink<M>): Request;

  /**
   * Fetch content from the platform's API
   */
  abstract fetchContent(
    snsLink: SnsLink<M>,
    progressCallback?: ProgressFn,
  ): Promise<PostData<M>[]>;

  abstract buildDiscordAttachments(
    postData: PostData<M>,
  ): MessageCreateOptions[];

  /**
   * Build a Discord message using the fetched content and images.
   * If template is provided, it overrides the default message format.
   */
  abstract buildDiscordMessages(
    postData: PostData<M>,
    attachmentURLs: string[],
    template?: string,
  ): MessageCreateOptions[];

  /**
   * Download images from URLs
   */
  protected async downloadImages(urls: string[]): Promise<Buffer[]> {
    const ps = urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download image (${res.status}): ${url}`);
      }

      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    });

    return Promise.all(ps);
  }
}
