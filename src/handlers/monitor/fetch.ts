/**
 * Monitor polling: orchestrates provider fetch modules (list + hydrate), DB seen state,
 * review creation, and `/fetch-all` sync.
 */
import type { Database } from "bun:sqlite";
import {
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, PostData } from "../../platforms/base";
import { getFileExtFromURL } from "../../utils/http";
import { sendOpsAlert } from "../../utils/opsAlert";
import { convertHeicToJpeg } from "../../utils/heic";
import { buildInlineFormatContent } from "../../utils/template";
import type { MonitorsConfig } from "./config";
import { findConnectionById, getConnectionId } from "./config";
import {
  getConnectionDb,
  isPostSeen,
  markPostSeen,
  upsertConnectionMeta,
} from "./db";
import { batchToMessageOptions, buildReviewBatches } from "./embed";
import { fetchInstagramConnectionPosts } from "./fetch/instagram";
import { fetchTiktokFeed } from "./fetch/tiktok";
import { fetchTwitterFeedRapidApi } from "./fetch/twitter";
import { createReview, deleteReview, type ReviewState } from "./review";

/** Media download helper injected from the monitor orchestrator (HEIC conversion, etc.). */
export type DownloadFilesFromUrls = (urls: string[]) => Promise<
  { ext: string; buffer: Buffer }[]
>;

/**
 * Filter to unseen, mark all unseen ids, then take the first `limit` for processing.
 */
export function selectUnseenMarkAllSlice<T>(
  items: T[],
  getId: (t: T) => string,
  isPostSeen: ((id: string) => boolean) | undefined,
  markPostSeen: ((id: string) => void) | undefined,
  limit: number,
): T[] {
  const unseen = items.filter((item) => {
    const id = getId(item);
    return !id || !isPostSeen?.(id);
  });
  for (const item of unseen) {
    const id = getId(item);
    if (id) markPostSeen?.(id);
  }
  return unseen.slice(0, limit);
}

const log = logger.child({ module: "monitor/fetch" });

async function downloadFilesFromUrls(urls: string[]) {
  const buffers = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download media (${res.status}): ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    }),
  );

  return convertHeicToJpeg(
    buffers.map((buf, i) => ({
      ext: getFileExtFromURL(urls[i]),
      buffer: buf,
    })),
  );
}

function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member as any;
  const memberDisplayName = member && typeof member.displayName === "string" ? member.displayName : null;
  return (
    memberDisplayName ??
    interaction.user.displayName ??
    interaction.user.username
  );
}

export async function fetchConnectionAndCreateReviews(
  interaction: ButtonInteraction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  metadataDb: Database,
  connectionId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = findConnectionById(monitorsConfig, connectionId);
  if (!connection) {
    await interaction.editReply({ content: "Unknown connection." });
    return;
  }

  await interaction.editReply("Fetching latest posts...");

  const connectionDb = getConnectionDb(connectionId);

  const MAX_REVIEWS_PER_POLL = 3;
  const MAX_STORIES_PER_POLL = 10;

  let posts: PostData<AnySnsMetadata>[] = [];
  if (connection.type === "instagram") {
    try {
      if (!connection.igId) {
        await interaction.editReply("Instagram ID not configured for this connection.");
        return;
      }

      posts = await fetchInstagramConnectionPosts(
        connection.handle,
        connection.igId,
        downloadFilesFromUrls,
        {
          isPostSeen: (id) => isPostSeen(connectionDb, id),
          markPostSeen: (id) => markPostSeen(connectionDb, id),
          limit: MAX_REVIEWS_PER_POLL,
        },
      );
    } catch (err) {
      log.error({ err, igUsername: connection.handle }, "Failed to fetch Instagram connection");
      await interaction.editReply(
        "Failed to fetch Instagram posts/stories. Please try again. Details were posted in this channel.",
      );
      const pollChannel = interaction.channel;
      if (pollChannel?.isSendable() && err instanceof AggregateError) {
        await sendOpsAlert(
          pollChannel,
          `Monitor poll failed — Instagram @${connection.handle}`,
          err,
          `Connection: \`${connectionId}\``,
        );
      }
      return;
    }
  } else if (connection.type === "tiktok") {
    try {
      posts = await fetchTiktokFeed(connection.handle, downloadFilesFromUrls, {
        isPostSeen: (id) => isPostSeen(connectionDb, id),
        markPostSeen: (id) => markPostSeen(connectionDb, id),
        limit: MAX_REVIEWS_PER_POLL,
      });
    } catch (err) {
      log.error({ err, handle: connection.handle }, "Failed to fetch TikTok feed");
      await interaction.editReply(
        "Failed to fetch TikTok feed. Please try again. Details were posted in this channel.",
      );
      const pollChannel = interaction.channel;
      if (pollChannel?.isSendable() && err instanceof AggregateError) {
        await sendOpsAlert(
          pollChannel,
          `Monitor poll failed — TikTok @${connection.handle}`,
          err,
          `Connection: \`${connectionId}\``,
        );
      }
      return;
    }
  } else if (connection.type === "twitter") {
    try {
      posts = await fetchTwitterFeedRapidApi(connection.handle, downloadFilesFromUrls, {
        isPostSeen: (id) => isPostSeen(connectionDb, id),
        markPostSeen: (id) => markPostSeen(connectionDb, id),
        limit: MAX_REVIEWS_PER_POLL,
      });
    } catch (err) {
      log.error({ err, handle: connection.handle }, "Failed to fetch Twitter feed");
      await interaction.editReply(
        "Failed to fetch Twitter feed. Please try again. Details were posted in this channel.",
      );
      const pollChannel = interaction.channel;
      if (pollChannel?.isSendable() && err instanceof AggregateError) {
        await sendOpsAlert(
          pollChannel,
          `Monitor poll failed — Twitter @${connection.handle}`,
          err,
          `Connection: \`${connectionId}\``,
        );
      }
      return;
    }
  }

  let newPosts: PostData<AnySnsMetadata>[];

  newPosts = posts;

  if (newPosts.length === 0) {
    upsertConnectionMeta(metadataDb, connectionId, Date.now(), getDisplayName(interaction));
    await interaction.editReply("No new posts found.");
    return;
  }

  const reviewChannel = interaction.channel;
  if (!reviewChannel || !("send" in reviewChannel)) {
    await interaction.editReply("Cannot send review messages in this channel.");
    return;
  }

  let postsToReview: PostData<AnySnsMetadata>[] = [];
  let stories: PostData<AnySnsMetadata>[] = [];
  let regularPosts: PostData<AnySnsMetadata>[] = [];

  if (connection.type === "instagram") {
    const isInstagramStory = (p: PostData<AnySnsMetadata>): boolean =>
      p.postLink?.metadata?.platform === "instagram-story";

    stories = newPosts.filter(isInstagramStory);
    regularPosts = newPosts.filter(p => !isInstagramStory(p));
    postsToReview = [
      ...stories.slice(0, MAX_STORIES_PER_POLL),
      ...regularPosts.slice(0, MAX_REVIEWS_PER_POLL),
    ];
  } else {
    postsToReview = newPosts.slice(0, MAX_REVIEWS_PER_POLL);
  }

  const socialsChannelId = monitorsConfig.socials_channel_id;
  let reviewCount = 0;

  for (const postData of postsToReview) {
    if (!postData.postID) continue;

    const allFileNames = postData.files.map((f, i) => `media-${i}.${f.ext}`);
    const renderedContent = buildInlineFormatContent(monitorsConfig.template, postData as any);

    const reviewState: ReviewState = {
      postData,
      connectionId,
      removedIndices: new Set<number>(),
      customContent: null,
      renderedContent,
      socialsChannelId,
      format: monitorsConfig.format,
      template: monitorsConfig.template,
      fetcherUserId: interaction.user.id,
      fileNames: allFileNames,
      messageIds: [],
    };

    const reviewId = createReview(reviewState);

    try {
      const batches = buildReviewBatches(reviewState, reviewId);
      const messageIds: string[] = [];

      for (const batch of batches) {
        const msg = await (reviewChannel as SendableChannels).send(
          batchToMessageOptions(batch),
        );
        messageIds.push(msg.id);
      }

      reviewState.messageIds = messageIds;

      reviewCount++;
      if (postData.postID) markPostSeen(connectionDb, postData.postID);
    } catch (err) {
      log.error({ err, reviewId }, "Failed to send review message");
      deleteReview(reviewId);
    }
  }

  upsertConnectionMeta(metadataDb, connectionId, Date.now(), getDisplayName(interaction));

  if (connection.type === "instagram") {
    await interaction.editReply(
      `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"} (${stories.length} story${stories.length === 1 ? "" : "s"} + ${regularPosts.slice(0, MAX_REVIEWS_PER_POLL).length} post${regularPosts.slice(0, MAX_REVIEWS_PER_POLL).length === 1 ? "" : "s"}). Review messages created below.`,
    );
  } else {
    await interaction.editReply(
      `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review messages created below.`,
    );
  }
}

/**
 * Polls every monitor connection: marks all current feed/story items as seen without
 * creating review messages or downloading media (except API calls required to list items).
 * Updates last-fetch metadata per connection.
 */
export async function syncAllMonitorConnections(
  monitorsConfig: MonitorsConfig,
  metadataDb: Database,
  opts?: { lastFetchedBy?: string },
): Promise<void> {
  const lastFetchedBy = opts?.lastFetchedBy ?? "fetch-all";
  const now = Date.now();

  for (const connection of monitorsConfig.connections) {
    const connectionId = getConnectionId(connection);
    const connectionDb = getConnectionDb(connectionId);

    const shared = {
      isPostSeen: (id: string) => isPostSeen(connectionDb, id),
      markPostSeen: (id: string) => markPostSeen(connectionDb, id),
    };

    try {
      if (connection.type === "instagram") {
        if (!connection.igId) {
          log.warn({ connectionId }, "fetch-all: skipping Instagram connection without igId");
          continue;
        }
        await fetchInstagramConnectionPosts(connection.handle, connection.igId, downloadFilesFromUrls, {
          ...shared,
          limit: 0,
          storiesMarkSeenOnly: true,
        });
      } else if (connection.type === "tiktok") {
        await fetchTiktokFeed(connection.handle, downloadFilesFromUrls, {
          ...shared,
          limit: 0,
        });
      } else if (connection.type === "twitter") {
        await fetchTwitterFeedRapidApi(connection.handle, downloadFilesFromUrls, {
          ...shared,
          limit: 0,
        });
      }

      upsertConnectionMeta(metadataDb, connectionId, now, lastFetchedBy);
    } catch (err) {
      log.error({ err, connectionId }, "fetch-all: connection sync failed");
    }
  }
}
