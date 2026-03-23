import type { Database } from "bun:sqlite";
import {
  AttachmentBuilder,
  type ButtonInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import config from "../../config/config";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import { InstagramPostDownloader } from "../../platforms/instagram-post/downloader";
import {
  BdTriggerResponseSchema,
  type InstagramPostElement,
} from "../../platforms/instagram-post/types";
import type { AnySnsMetadata, InstagramMetadata, PostData } from "../../platforms/base";
import { getFileExtFromURL } from "../../utils/http";
import { convertHeicToJpeg } from "../../utils/heic";
import { buildInlineFormatContent } from "../../utils/template";
import type { MonitorsConfig } from "./config";
import { findConnectionById } from "./config";
import { isDevMode, loadMockJson } from "./runtime";
import {
  isPostSeen,
  getConnectionDb,
  markPostSeen,
  upsertConnectionMeta,
} from "./db";
import { buildReviewMessage } from "./embed";
import { createReview, deleteReview, type ReviewState } from "./review";

const log = logger.child({ module: "monitor/fetch" });

const downloader = new InstagramPostDownloader();

// Guard against concurrent fetches for the same username (double-click race condition)
const fetchingInProgress = new Set<string>();

/**
 * Fetch all posts for an Instagram profile via the Brightdata API.
 * Uses the same dataset ID as the post downloader but with a profile URL payload.
 */
export async function fetchIgProfilePosts(
  igUsername: string,
): Promise<InstagramPostElement[]> {
  if (isDevMode()) {
    return loadMockJson<InstagramPostElement[]>("instagram-posts.json");
  }

  const profileUrl = `https://www.instagram.com/${igUsername}/`;

  const triggerReq = new Request(
    "https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_lk5ns7kz21pck8jpis&include_errors=true",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.BD_API_TOKEN}`,
      },
      body: JSON.stringify([{ url: profileUrl }]),
    },
  );

  const triggerRes = await fetch(triggerReq);
  if (triggerRes.status !== 200) {
    throw new Error(
      `Failed to trigger IG profile fetch: ${triggerRes.status}`,
    );
  }

  const triggerJson = await triggerRes.json();
  const triggerParsed = BdTriggerResponseSchema.parse(triggerJson);

  if (!triggerParsed.snapshot_id) {
    throw new Error("No snapshot_id in trigger response");
  }

  const snapshotId = triggerParsed.snapshot_id;

  log.debug({ igUsername, snapshotId }, "Waiting for IG profile snapshot");
  // Profile scrapes return multiple posts and take longer than single-post scrapes
  await downloader.waitUntilDataReady(snapshotId, 120_000);

  return downloader.fetchAllSnapshotData(snapshotId);
}

/**
 * Build PostData for an InstagramPostElement.
 * Downloads and converts media.
 */
async function buildPostData(
  igPost: InstagramPostElement,
  igUsername: string,
): Promise<PostData<InstagramMetadata> | null> {
  if (!igPost.post_content || igPost.post_content.length === 0) {
    log.warn({ igPost }, "IG post has no content, skipping");
    return null;
  }

  const mediaUrls = igPost.post_content
    .map((m) => m.url)
    .filter((x): x is string => !!x);

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

function getDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member as any;
  const memberDisplayName = member && typeof member.displayName === "string" ? member.displayName : null;
  return (
    memberDisplayName ??
    interaction.user.displayName ??
    interaction.user.username
  );
}

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

async function fetchInstagramStoriesRapidApi(
  igUsername: string,
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-stories.json");
    const items: any[] = Array.isArray(mock?.result) ? mock.result : [];
    return buildStoryPostDataFromRapidApi(igUsername, items);
  }

  const req = new Request(
    "https://instagram120.p.rapidapi.com/api/instagram/stories",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "instagram120.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
      body: JSON.stringify({ username: igUsername }),
    },
  );

  const res = await fetch(req);
  if (!res.ok) {
    throw new Error(`Failed to fetch instagram stories (${res.status})`);
  }

  const json: any = await res.json();

  // RapidAPI responses can vary; normalize into a flat list of story items.
  const resultItems: any[] = Array.isArray(json?.result) ? json.result : [];
  const nestedItems: any[] = resultItems.flatMap((entry: any) => {
    if (Array.isArray(entry?.items)) return entry.items;
    if (Array.isArray(entry?.stories)) return entry.stories;
    if (Array.isArray(entry?.result)) return entry.result;
    return [];
  });
  const items: any[] = nestedItems.length > 0 ? nestedItems : resultItems;

  return buildStoryPostDataFromRapidApi(igUsername, items);
}

async function buildStoryPostDataFromRapidApi(
  igUsername: string,
  items: any[],
): Promise<PostData<AnySnsMetadata>[]> {
  const out: PostData<AnySnsMetadata>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const candidateUrls: string[] = Array.isArray(item?.candidates)
      ? item.candidates
          .map((c: any) => c?.url)
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    const imageVersionCandidateUrls: string[] = Array.isArray(item?.image_versions2?.candidates)
      ? item.image_versions2.candidates
          .map((c: any) => c?.url)
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    const videoUrls: string[] = Array.isArray(item?.video_versions)
      ? item.video_versions
          .map((v: any) => v?.url)
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    const mediaUrls = [...videoUrls, ...candidateUrls, ...imageVersionCandidateUrls];
    if (mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls([mediaUrls[0]]);
    const storyId = String(item?.id ?? item?.pk ?? `story-${igUsername}-${i}`);

    out.push({
      postLink: {
        url: `https://www.instagram.com/${igUsername}/`,
        metadata: { platform: "instagram-story" as const },
      },
      username: igUsername,
      postID: `ig-story:${igUsername}:${storyId}`,
      originalText: "",
      timestamp: item?.taken_at ? new Date(Number(item.taken_at) * 1000) : undefined,
      files,
    });
  }

  return out;
}

async function fetchTiktokFeedRapidApi(
  handle: string,
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("tiktok-feed.json");
    return buildTiktokPostDataFromRapidApi(handle, mock);
  }

  const req = new Request(
    `https://tiktok-best-experience.p.rapidapi.com/user/${encodeURIComponent(handle)}/feed`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "tiktok-best-experience.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
    },
  );

  const res = await fetch(req);
  if (!res.ok) {
    throw new Error(`Failed to fetch tiktok feed (${res.status})`);
  }

  const json: any = await res.json();
  return buildTiktokPostDataFromRapidApi(handle, json);
}

async function buildTiktokPostDataFromRapidApi(
  handle: string,
  json: any,
): Promise<PostData<AnySnsMetadata>[]> {
  const awemeList: any[] = Array.isArray(json?.data?.aweme_list)
    ? json.data.aweme_list
    : [];

  const out: PostData<AnySnsMetadata>[] = [];
  for (const aweme of awemeList) {
    const awemeId = String(aweme?.aweme_id ?? "");
    if (!awemeId) continue;

    const videoUrls: string[] = Array.isArray(aweme?.video?.play_addr?.url_list)
      ? aweme.video.play_addr.url_list.filter(
          (u: unknown): u is string => typeof u === "string" && u.length > 0,
        )
      : [];

    const imageUrls: string[] = Array.isArray(aweme?.image_post_info?.images)
      ? aweme.image_post_info.images
          .flatMap((img: any) =>
            Array.isArray(img?.display_image?.url_list) ? img.display_image.url_list : [],
          )
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    const mediaUrls = videoUrls.length > 0 ? [videoUrls[0]] : imageUrls;
    if (mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls(mediaUrls);
    const username = aweme?.author?.unique_id || handle;
    const postUrl =
      aweme?.share_url || `https://www.tiktok.com/@${username}/video/${awemeId}`;

    out.push({
      postLink: {
        url: postUrl,
        metadata: { platform: "tiktok" as const, videoId: awemeId },
      },
      username,
      postID: awemeId,
      originalText: aweme?.desc || "",
      timestamp: aweme?.create_time ? new Date(Number(aweme.create_time) * 1000) : undefined,
      files,
    });
  }

  return out;
}

async function buildTwitterPostDataFromMock(): Promise<PostData<AnySnsMetadata>[]> {
  const json = loadMockJson<any>("twitter-feed.json");
  const items: any[] = Array.isArray(json?.data) ? json.data : [];

  const out: PostData<AnySnsMetadata>[] = [];
  for (const item of items) {
    const postId = String(item?.post_id ?? item?.id ?? "");
    const username = String(item?.username ?? "unknown");
    const postUrl = String(item?.post_url ?? "");
    const mediaUrls: string[] = Array.isArray(item?.media_urls)
      ? item.media_urls.filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    if (!postId || !postUrl || mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls(mediaUrls);
    out.push({
      postLink: {
        url: postUrl,
        metadata: { platform: "twitter", username, id: postId },
      },
      username,
      postID: postId,
      originalText: String(item?.caption ?? item?.text ?? ""),
      timestamp: item?.timestamp ? new Date(item.timestamp) : undefined,
      files,
    });
  }

  return out;
}

async function fetchInstagramConnectionPosts(
  igUsername: string,
): Promise<PostData<AnySnsMetadata>[]> {
  const [profilePosts, storyPosts] = await Promise.all([
    fetchIgProfilePosts(igUsername),
    fetchInstagramStoriesRapidApi(igUsername),
  ]);

  const postDatasFromProfile = await Promise.all(
    profilePosts.map((p) => buildPostData(p, igUsername)),
  );

  const profileDatas = postDatasFromProfile.filter(
    (x): x is PostData<InstagramMetadata> => x !== null,
  );

  return [...profileDatas, ...storyPosts] as PostData<AnySnsMetadata>[];
}

export async function fetchConnectionAndCreateReviews(
  interaction: ButtonInteraction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  metadataDb: Database,
  connectionId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const connection = findConnectionById(monitorsConfig, connectionId);
  if (!connection) {
    await interaction.editReply({ content: "Unknown connection." });
    return;
  }

  if (fetchingInProgress.has(connectionId)) {
    await interaction.editReply("A poll is already running for this connection. Please wait.");
    return;
  }

  fetchingInProgress.add(connectionId);
  try {
    await interaction.editReply("Fetching latest posts...");

    const connectionDb = getConnectionDb(connectionId);

    let posts: PostData<AnySnsMetadata>[] = [];
    if (connection.type === "instagram") {
      try {
        posts = await fetchInstagramConnectionPosts(connection.handle);
      } catch (err) {
        log.error({ err, igUsername: connection.handle }, "Failed to fetch Instagram connection");
        await interaction.editReply("Failed to fetch Instagram posts/stories. Please try again.");
        return;
      }
    } else if (connection.type === "tiktok") {
      try {
        posts = await fetchTiktokFeedRapidApi(connection.handle);
      } catch (err) {
        log.error({ err, handle: connection.handle }, "Failed to fetch TikTok feed");
        await interaction.editReply("Failed to fetch TikTok feed. Please try again.");
        return;
      }
    } else if (connection.type === "twitter") {
      if (isDevMode()) {
        try {
          posts = await buildTwitterPostDataFromMock();
        } catch (err) {
          log.error({ err }, "Failed to parse twitter mock data");
          await interaction.editReply("Failed to parse twitter mock data.");
          return;
        }
      } else {
      log.warn({ connectionId }, "Twitter polling not implemented yet (API endpoints TBD).");
      await interaction.editReply("Twitter polling not implemented yet.");
      upsertConnectionMeta(metadataDb, connectionId, Date.now(), getDisplayName(interaction));
      return;
      }
    }

    // Filter unseen posts for this connection.
    const newPosts = posts.filter((p) => {
      if (!p.postID) return false;
      return !isPostSeen(connectionDb, p.postID);
    });

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

    const socialsChannelId = monitorsConfig.socials_channel_id;
    let reviewCount = 0;

    for (const postData of newPosts) {
      if (!postData.postID) continue;

      const fileNames = postData.files.map((f, i) => `media-${i}.${f.ext}`);
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
        fileNames,
      };

      const reviewId = createReview(reviewState);
      const attachments = postData.files.map((f, i) =>
        new AttachmentBuilder(f.buffer).setName(fileNames[i]),
      );

      try {
        await (reviewChannel as SendableChannels).send(
          buildReviewMessage(reviewState, reviewId, attachments),
        );
        reviewCount++;
        markPostSeen(connectionDb, postData.postID);
      } catch (err) {
        log.error({ err, reviewId }, "Failed to send review message");
        deleteReview(reviewId);
      }
    }

    upsertConnectionMeta(metadataDb, connectionId, Date.now(), getDisplayName(interaction));

    await interaction.editReply(
      `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review messages created above.`,
    );
  } finally {
    fetchingInProgress.delete(connectionId);
  }
}
