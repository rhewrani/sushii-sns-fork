import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { platformToString, type AnySnsMetadata, type Platform, type PostData } from "../platforms/base";
import {
  AttachmentBuilder,
  MessageFlags,
  type Message,
  type SendableChannels,
} from "discord.js";
import { buildInlineFormatContent, buildLinksFormatMessages, suppressLinksInTextExceptLast } from "./template";
import logger from "../logger";

const log = logger.child({ module: "utils/discord" });

dayjs.extend(utc);
dayjs.extend(timezone);

export const KST_TIMEZONE = "Asia/Seoul";
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export function formatDiscordTitle(
  platform: Platform,
  username: string,
  date?: Date,
): string {
  const djs = dayjs(date).tz(KST_TIMEZONE);

  let title = "`";
  if (date) {
    title += djs.format("YYMMDD");
    title += " ";
  }

  const platformName = platformToString(platform);
  title += `${username} ${platformName} Update`;
  title += "`";

  return title;
}

// joins items into a string with a separator, multiple chunks with max
// length of 2000 characters
export function itemsToMessageContents(
  initialMsg: string,
  items: string[],
): string[] {
  const msgs = [];
  let currentMsg = initialMsg;

  for (const item of items) {
    if (currentMsg.length + item.length > 2000) {
      if (currentMsg.length > 0) {
        msgs.push(currentMsg);
      }
      currentMsg = "";
    }

    currentMsg += item + "\n";
  }

  // Push last message if not empty
  if (currentMsg.length > 0) {
    msgs.push(currentMsg);
  }

  return msgs;
}

export function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }

  return chunks;
}

export interface SendPostOptions {
  format: "inline" | "links";
  template?: string;
  /** Optional: prefix content (e.g., "Posted by @user") */
  prefix?: string;
  /** Optional: suppress embeds (default: true) */
  suppressEmbeds?: boolean;
  /** Optional: connection DB to auto-record posted message ID */
  connectionDb?: { run: (sql: string, ...params: any[]) => any }; // minimal DB interface
  /** Optional: post ID to track in DB (required if connectionDb provided) */
  postId?: string;
}

export interface SendPostResult {
  /** All message IDs that were sent (in order) */
  messageIds: string[];
  /** The full Message objects if you need to reference them immediately */
  messages: Message[];
}

/**
 * Send a PostData to a Discord channel using review-style formatting.
 * Handles inline (text+attachments) and links (text+CDN URLs) formats.
 * Automatically chunks attachments to respect Discord's 10-per-message limit.
 * 
 * @returns Object with sent message IDs and Message objects for tracking
 */
export async function sendPostToChannel(
  channel: SendableChannels,
  postData: PostData<AnySnsMetadata>,
  options: SendPostOptions,
): Promise<SendPostResult> {
  const { format, template, prefix, suppressEmbeds = true, connectionDb, postId } = options;
  const files = postData.files;
  const hasMedia = files.length > 0;
  const flags = (suppressEmbeds && hasMedia) ? MessageFlags.SuppressEmbeds : undefined;

  const result: SendPostResult = { messageIds: [], messages: [] };

  // Helper to send with optional prefix and track result
  const sendAndTrack = async (content: string, extra?: Record<string, unknown>) => {
    const finalContent = prefix ? `${prefix}\n${content}` : content;
    const sent = await channel.send({
      content: finalContent,
      flags,
      ...extra,
    });
    result.messageIds.push(sent.id);
    result.messages.push(sent);
    return sent;
  };

  if (format === "inline") {
    // === INLINE FORMAT: text + direct attachments ===
    const content = buildInlineFormatContent(template ?? "", postData as any);
    const attachments = files.map((f, i) =>
      new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`)
    );
    const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);

    if (chunks.length === 0) {
      // Text-only post
      log.info(`Sending text-only post`);
      await sendAndTrack(suppressLinksInTextExceptLast?.(content) ?? content);
    } else {
      // Send text first, then media chunks
      log.info(`Sending text + media chunks`);
      await sendAndTrack(content);
      for (const chunk of chunks) {
        const sent = await channel.send({ files: chunk, flags });
        result.messageIds.push(sent.id);
        result.messages.push(sent);
      }
    }
  } else {
    // === LINKS FORMAT: upload attachments → get CDN URLs → send text with URLs ===
    const attachments = files.map((f, i) =>
      new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`)
    );
    const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
    const cdnUrls: string[] = [];

    // Upload all media first to get Discord CDN URLs
    for (const chunk of chunks) {
      const sent = await channel.send({ files: chunk, flags });
      result.messageIds.push(sent.id);
      result.messages.push(sent);
      for (const att of sent.attachments.values()) {
        cdnUrls.push(att.url);
      }
    }

    // Build and send formatted text messages with CDN URLs
    const textMsgs = buildLinksFormatMessages(
      template ?? "",
      postData as any,
      cdnUrls
    );
    for (const msg of textMsgs) {
      const sent = await channel.send({ ...msg, flags });
      result.messageIds.push(sent.id);
      result.messages.push(sent);
    }
  }

  if (connectionDb && postId && result.messageIds.length > 0) {
    try {
      const rawPlatform = postData.postLink.metadata.platform;
      const normalizedPlatform = rawPlatform.replace(/-story$/, "");
      
      // Use INSERT OR REPLACE to handle both new posts and previously-seen-but-not-posted
      connectionDb.run(
        "INSERT OR REPLACE INTO seen_posts (post_id, seen_at, posted_message_id) VALUES (?, ?, ?)",
        postId,
        Date.now(),
        result.messageIds[0]
      );
    } catch (err) {
      log.error(err, "Failed to track posted message ID in DB");
    }
  }
  return result;
}