import type { Database } from "bun:sqlite";
import {
  AttachmentBuilder,
  DiscordAPIError,
  GuildMember,
  type ButtonInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import config from "../../config/config";
import type { ServerConfig } from "../../config/server_config";
import { getGuildTemplate } from "../../config/server_config";
import logger from "../../logger";
import {
  InstagramPostDownloader,
  extractMediaUrls,
} from "../../platforms/instagram-post/downloader";
import {
  BdScrapeResponseSchema,
  InstagramPostListSchema,
  type InstagramPostElement,
} from "../../platforms/instagram-post/types";
import type { InstagramMetadata, PostData } from "../../platforms/base";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import {
  buildInlineFormatContent,
  DEFAULT_LINKS_TEMPLATE,
  DEFAULT_INLINE_TEMPLATE,
} from "../../utils/template";
import type { MonitorsConfig, Subscription } from "./config";
import {
  findSubscriptionByChannel,
  FETCH_COOLDOWN_SECONDS,
} from "./config";
import {
  getLastFetch,
  isPostSeen,
  upsertLastFetch,
  getMonitorMessage,
} from "./db";
import { buildStatusEmbed, buildReviewMessage } from "./embed";
import { createReview, deleteReview, type ChannelConfig } from "./review";

const log = logger.child({ module: "monitor/fetch" });

const BD_SCRAPE_URL =
  "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_lk5ns7kz21pck8jpis&notify=false&include_errors=true";

const downloader = new InstagramPostDownloader();

// Guard against concurrent fetches for the same username (double-click race condition)
const fetchingInProgress = new Set<string>();

/**
 * Fetch all posts for an Instagram profile via the Brightdata scrape API.
 * Handles both synchronous (200) and asynchronous (202) responses.
 */
export async function fetchIgProfilePosts(
  igUsername: string,
): Promise<InstagramPostElement[]> {
  const profileUrl = `https://www.instagram.com/${igUsername}/`;

  const req = new Request(BD_SCRAPE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.BD_API_TOKEN}`,
    },
    body: JSON.stringify({ input: [{ url: profileUrl }] }),
  });

  const res = await fetch(req);

  if (res.status === 200) {
    const rawJson = await res.json();
    const arr = Array.isArray(rawJson) ? rawJson : [rawJson];
    return InstagramPostListSchema.parse(arr);
  }

  if (res.status === 202) {
    const body = BdScrapeResponseSchema.parse(await res.json());
    if (!body.snapshot_id) throw new Error("No snapshot_id in 202 response");
    log.debug({ igUsername, snapshotId: body.snapshot_id }, "IG profile scrape async, polling...");
    // Profile scrapes can return many posts, allow longer timeout
    return downloader.waitAndFetch(body.snapshot_id, 120_000);
  }

  throw new Error(`Failed to fetch IG profile posts: ${res.status}`);
}

/**
 * Build PostData for an InstagramPostElement.
 * Downloads and converts media.
 */
async function buildPostData(
  igPost: InstagramPostElement,
  igUsername: string,
): Promise<PostData<InstagramMetadata> | null> {
  const { urls: mediaUrls } = extractMediaUrls(igPost);
  if (mediaUrls.length === 0) {
    log.warn({ igPost }, "IG post has no media URLs, skipping");
    return null;
  }

  // Download media
  const ps = mediaUrls.map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download media (${res.status}): ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  });

  const buffers = await Promise.all(ps);

  const files = await convertHeicToJpeg(
    buffers.map((buf, i) => ({
      ext: getFileExtFromURL(mediaUrls[i]),
      buffer: buf,
    })),
  );

  const postUrl = igPost.url ?? `https://www.instagram.com/${igUsername}/`;

  return {
    postLink: {
      url: postUrl,
      metadata: { platform: "instagram" as const },
    },
    username: igPost.user_posted || igUsername,
    postID: igPost.post_id || "",
    originalText: igPost.description || "",
    timestamp: igPost.timestamp,
    files,
  };
}

/**
 * Update all embed messages for a subscription across all watcher channels.
 */
export async function updateAllEmbeds(
  igUsername: string,
  subscription: Subscription,
  client: Client,
  db: Database,
): Promise<void> {
  const lastFetch = getLastFetch(db, igUsername);

  for (const watcher of subscription.watchers) {
    const stored = getMonitorMessage(db, igUsername, watcher.channel_id);
    if (!stored) continue;

    try {
      const channel = await client.channels.fetch(watcher.channel_id);
      if (!channel || !channel.isTextBased()) continue;

      const msg = await channel.messages.fetch(stored.message_id);
      const embedData = buildStatusEmbed(igUsername, lastFetch);
      await msg.edit({ ...embedData, embeds: [] } as any);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 10008) {
        log.warn(
          { igUsername, channelId: watcher.channel_id },
          "Monitor embed message was deleted, skipping update",
        );
      } else {
        log.error(err, "Failed to update monitor embed");
      }
    }
  }
}

/**
 * Main fetch-and-post handler triggered by the "Fetch New Posts" button.
 */
export async function fetchAndPost(
  interaction: ButtonInteraction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  db: Database,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const result = findSubscriptionByChannel(
    monitorsConfig,
    interaction.channelId,
  );

  if (!result) {
    await interaction.editReply(
      "This channel is not configured as a monitor watcher.",
    );
    return;
  }

  const [subscription, watcher] = result;
  const { ig_username: igUsername } = subscription;

  // Role check
  if (watcher.allowed_role_id) {
    const member = interaction.member;
    if (!member) {
      await interaction.editReply("Could not verify your roles.");
      return;
    }

    const roles =
      "cache" in member.roles
        ? member.roles.cache
        : null;

    if (!roles || !roles.has(watcher.allowed_role_id)) {
      await interaction.editReply(
        "You don't have the required role to fetch posts.",
      );
      return;
    }
  }

  // Cooldown check
  const lastFetch = getLastFetch(db, igUsername);
  if (lastFetch) {
    const nextFetchAt =
      lastFetch.last_fetched_at + FETCH_COOLDOWN_SECONDS * 1000;
    if (Date.now() < nextFetchAt) {
      const nextFetchSec = Math.floor(nextFetchAt / 1000);
      await interaction.editReply(
        `On cooldown. Next fetch available <t:${nextFetchSec}:R>.`,
      );
      return;
    }
  }

  if (fetchingInProgress.has(igUsername)) {
    await interaction.editReply(
      "A fetch is already in progress for this profile. Please wait.",
    );
    return;
  }

  const reviewChannel = interaction.channel;
  if (!reviewChannel || !("send" in reviewChannel)) {
    await interaction.editReply("Cannot send review messages in this channel.");
    return;
  }

  await interaction.editReply("Fetching new posts...");

  fetchingInProgress.add(igUsername);
  try {
    let igPosts: InstagramPostElement[];
    try {
      igPosts = await fetchIgProfilePosts(igUsername);
    } catch (err) {
      log.error(err, "Failed to fetch IG profile posts");
      await interaction.editReply(
        "Failed to fetch posts from Instagram. Please try again.",
      );
      return;
    }

    log.debug({ igUsername, count: igPosts.length }, "Fetched IG profile posts");

    // Filter to unseen posts with a valid post_id
    const newPosts = igPosts.filter(
      (p) => p.post_id && !isPostSeen(db, igUsername, p.post_id),
    );

    log.debug(
      { igUsername, newCount: newPosts.length },
      "New unseen IG posts",
    );

    if (newPosts.length === 0) {
      // Still update last fetch time and embeds
      const member = interaction.member;
      const displayName =
        (member instanceof GuildMember ? member.displayName : null) ??
        interaction.user.displayName ??
        interaction.user.username;

      upsertLastFetch(db, igUsername, Date.now(), displayName);
      await updateAllEmbeds(igUsername, subscription, client, db);

      await interaction.editReply("No new posts found.");
      return;
    }

    // Build per-watcher channel configs once (doesn't depend on individual post data)
    const channelConfigs: ChannelConfig[] = subscription.watchers.map((w) => ({
      channelId: w.channel_id,
      format: w.format,
      template:
        w.template ??
        getGuildTemplate(serverConfig, w.guild_id) ??
        (w.format === "inline" ? DEFAULT_INLINE_TEMPLATE : DEFAULT_LINKS_TEMPLATE),
    }));

    let reviewCount = 0;

    for (const igPost of newPosts) {
      const postData = await buildPostData(igPost, igUsername).catch((err) => {
        log.error(err, "Failed to build post data for IG post");
        return null;
      });

      if (!postData) continue;

      // Name files deterministically
      const fileNames = postData.files.map((f, i) => `media-${i}.${f.ext}`);

      // Pre-render using first watcher's template for modal pre-fill
      const renderedContent = buildInlineFormatContent(
        channelConfigs[0]?.template ?? DEFAULT_INLINE_TEMPLATE,
        postData,
      );

      const reviewState = {
        postData,
        igUsername,
        removedIndices: new Set<number>(),
        customContent: null,
        renderedContent,
        channelConfigs,
        fetcherUserId: interaction.user.id,
        fileNames,
      };
      const reviewId = createReview(reviewState);

      // Build attachment builders with deterministic names
      const attachments = postData.files.map((f, i) =>
        new AttachmentBuilder(f.buffer).setName(fileNames[i]),
      );

      try {
        const reviewMsg = await (reviewChannel as SendableChannels).send(
          buildReviewMessage(reviewState, reviewId, attachments),
        );
        log.debug({ reviewId, messageId: reviewMsg.id }, "Review message sent");
        reviewCount++;
      } catch (err) {
        log.error({ err, reviewId }, "Failed to send review message");
        deleteReview(reviewId);
      }
    }

    const member = interaction.member;
    const displayName =
      (member instanceof GuildMember ? member.displayName : null) ??
      interaction.user.displayName ??
      interaction.user.username;

    upsertLastFetch(db, igUsername, Date.now(), displayName);
    await updateAllEmbeds(igUsername, subscription, client, db);

    await interaction.editReply(
      `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review above.`,
    );
  } finally {
    fetchingInProgress.delete(igUsername);
  }
}
