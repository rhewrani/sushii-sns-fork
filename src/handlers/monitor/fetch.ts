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
  RapidApiMediaResponseSchema,
  type InstagramPostElement,
  type RapidApiMediaResponse,
} from "../../platforms/instagram-post/types";
import type { AnySnsMetadata, InstagramMetadata, PostData } from "../../platforms/base";
import { tryWithFallbacks } from "../../utils/fallback";
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

async function fetchInstagramConnectionPosts(
  igUsername: string,
): Promise<PostData<AnySnsMetadata>[]> {
  const [profilePosts, storyPosts] = await Promise.all([
    fetchIgProfilePosts(igUsername),
    fetchInstagramStories(igUsername),
  ]);

  return [...profilePosts, ...storyPosts] as PostData<AnySnsMetadata>[];
}
/**
 * RapidAPI /posts may return a raw array or an object wrapping the array.
 * This helper extracts and validates the media items array.
 */
function parseRapidApiPostsResponse(json: any): RapidApiMediaResponse {
  // 1. Direct array
  if (Array.isArray(json)) {
    return RapidApiMediaResponseSchema.parse(json);
  }

  // 2. Object wrapper checks
  let items: any[] | undefined;

  if (Array.isArray(json?.data)) {
    items = json.data;
  } else if (Array.isArray(json?.result)) {
    items = json.result;
  } else if (Array.isArray(json?.result?.edges)) {
    // GraphQL shape: unwrap edges -> node
    items = json.result.edges.map((e: any) => e.node ?? e);
  } else if (Array.isArray(json?.items)) {
    items = json.items;
  }

  if (items) {
    // If the items are raw data (missing 'urls' key), map them to our format
    if (items.length > 0 && !items[0].urls) {
      log.debug(
        { itemCount: items.length, firstNodeKeys: Object.keys(items[0]) },
        "Mapping raw IG data to flattened format",
      );
      items = items.flatMap((node) => {
        const shortcode = node.shortcode ?? node.code;
        if (!shortcode) return [];

        const meta = {
          title:
            node.edge_media_to_caption?.edges?.[0]?.node?.text ??
            node.caption?.text ??
            "",
          sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
          shortcode,
          username: node.owner?.username ?? node.user?.username,
          takenAt: node.taken_at_timestamp ?? node.taken_at ?? node.device_timestamp,
        };

        // Try to find a media URL from various possible field names
        const findMediaUrl = (obj: any): string | undefined =>
          obj?.video_url ??
          obj?.display_url ??
          obj?.thumbnail_src ??
          obj?.image_versions2?.candidates?.[0]?.url ??
          obj?.thumbnail_resources?.[obj.thumbnail_resources.length - 1]?.src;

        // Handle Carousels
        if (node.edge_sidecar_to_children?.edges) {
          return node.edge_sidecar_to_children.edges
            .map((e: any) => {
              const child = e.node ?? e;
              const mediaUrl = findMediaUrl(child);
              if (!mediaUrl) return null;
              return {
                urls: [
                  {
                    url: mediaUrl,
                    name: child.is_video ? "MP4" : "JPG",
                    extension: child.is_video ? "mp4" : "jpg",
                  },
                ],
                meta,
                pictureUrl: child.display_url ?? child.thumbnail_src ?? mediaUrl,
              };
            })
            .filter(Boolean);
        }

        // Single photo/video
        const mediaUrl = findMediaUrl(node);
        if (!mediaUrl) {
          log.warn(
            { shortcode, nodeKeys: Object.keys(node) },
            "Could not find media URL in node, skipping",
          );
          return [];
        }

        return [
          {
            urls: [
              {
                url: mediaUrl,
                name: node.is_video ? "MP4" : "JPG",
                extension: node.is_video ? "mp4" : "jpg",
              },
            ],
            meta,
            pictureUrl: node.display_url ?? node.thumbnail_src ?? mediaUrl,
          },
        ];
      });
    }

    return RapidApiMediaResponseSchema.parse(items);
  }

  log.error(
    { responseKeys: Object.keys(json ?? {}) },
    "Unknown RapidAPI /posts response shape",
  );
  throw new Error("RapidAPI /posts returned unexpected response format");
}

/**
 * Fetch all posts for an Instagram profile via RapidAPI /posts endpoint.
 */
async function fetchIgProfilePostsViaRapidApi(
  igUsername: string,
): Promise<PostData<InstagramMetadata>[]> {
  let items: RapidApiMediaResponse;

  if (!isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi.json");
    items = parseRapidApiPostsResponse(mock);
  } else {
    const req = new Request(
      "https://instagram120.p.rapidapi.com/api/instagram/posts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "instagram120.p.rapidapi.com",
          "x-rapidapi-key": config.RAPID_API_KEY,
        },
        body: JSON.stringify({ username: igUsername, maxId: "" }),
      },
    );

    const res = await fetch(req);
    if (!res.ok) {
      throw new Error(`RapidAPI /posts failed (${res.status})`);
    }

    const rawJson = await res.json();
    items = parseRapidApiPostsResponse(rawJson);
  }

  const postDatas: PostData<InstagramMetadata>[] = [];

  // Group items by shortcode (carousel images share the same shortcode)
  const byShortcode = new Map<string, typeof items>();
  for (const item of items) {
    const sc = item.meta.shortcode ?? "unknown";
    const existing = byShortcode.get(sc) ?? [];
    existing.push(item);
    byShortcode.set(sc, existing);
  }

  for (const [shortcode, groupItems] of byShortcode) {
    const meta = groupItems[0].meta;
    const mediaUrls = groupItems
      .flatMap((gi) => gi.urls.map((u) => u.url))
      .filter((u) => u.length > 0);

    if (mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls(mediaUrls);

    postDatas.push({
      postLink: {
        url: meta.sourceUrl ?? `https://www.instagram.com/p/${shortcode}/`,
        metadata: { platform: "instagram" as const, shortcode },
      },
      username: meta.username || igUsername,
      postID: shortcode,
      originalText: meta.title || "",
      timestamp: meta.takenAt ? new Date(meta.takenAt * 1000) : undefined,
      files,
    });
  }

  return postDatas;
}

/**
 * Fetch all posts for an Instagram profile via the Brightdata API.
 * Uses the same dataset ID as the post downloader but with a profile URL payload.
 */
async function fetchIgProfilePostsViaBrightdata(
  igUsername: string,
): Promise<PostData<InstagramMetadata>[]> {
  if (isDevMode()) {
    const mockPosts = loadMockJson<InstagramPostElement[]>("instagram-posts.json");
    const postDatas = await Promise.all(
      mockPosts.map((p) => buildPostData(p, igUsername)),
    );
    return postDatas.filter(
      (x): x is PostData<InstagramMetadata> => x !== null,
    );
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
  await downloader.waitUntilDataReady(snapshotId, 120_000);

  const posts = await downloader.fetchAllSnapshotData(snapshotId);
  const postDatas = await Promise.all(
    posts.map((p) => buildPostData(p, igUsername)),
  );
  return postDatas.filter(
    (x): x is PostData<InstagramMetadata> => x !== null,
  );
}

/**
 * Fetch Instagram profile posts with fallbacks.
 * Primary: RapidAPI /posts, Last fallback: Brightdata.
 */
export async function fetchIgProfilePosts(
  igUsername: string,
): Promise<PostData<InstagramMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "Brightdata",
      fn: () => fetchIgProfilePostsViaBrightdata(igUsername),
    },
    {
      name: "RapidAPI /posts",
      fn: () => fetchIgProfilePostsViaRapidApi(igUsername),
    }
    // TODO: Add additional fallback provider here
    // { name: "Placeholder", fn: () => ... },
  ]);
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

async function fetchInstagramStoriesViaRapidApi(
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

/**
 * Fetch Instagram stories with fallbacks.
 * Primary: RapidAPI stories.
 */
async function fetchInstagramStories(
  igUsername: string,
): Promise<PostData<AnySnsMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI stories",
      fn: () => fetchInstagramStoriesViaRapidApi(igUsername),
    },
    // TODO: Add additional fallback provider here
    // { name: "Placeholder", fn: () => ... },
  ]);
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
    
    // enforce mp4 extension for videos since media url often lacks it
    if (videoUrls.length > 0 && files.length > 0) {
      files[0].ext = "mp4";
    }
    const username = aweme?.author?.unique_id || handle;
    let postUrl =
      aweme?.share_url || `https://www.tiktok.com/@${username}/video/${awemeId}`;

    if (postUrl.includes("?")) {
      postUrl = postUrl.substring(0, postUrl.indexOf("?"));
    }

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

function processText(item: any): string {
  let text = String(item?.text ?? "");

  const urls: any[] = item?.entities?.urls ?? [];
  for (const urlObj of urls) {
    if (urlObj?.url && urlObj?.expanded_url) {
      text = text.replace(urlObj.url, urlObj.expanded_url);
    }
  }

  text = text.replace(/https:\/\/t\.co\/\S+/g, "").trimEnd();

  return text;
}

async function fetchTwitterFeedRapidApi(
  handle: string,
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("twitter-feed.json");
    return buildTwitterPostDataFromRapidApi(handle, mock);
  }

  const req = new Request(
    `https://twitter-api45.p.rapidapi.com/timeline.php?screenname=${encodeURIComponent(handle)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "twitter-api45.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
    },
  );

  const res = await fetch(req);
  if (!res.ok) {
    throw new Error(`Failed to fetch twitter feed (${res.status})`);
  }

  const json: any = await res.json();
  return buildTwitterPostDataFromRapidApi(handle, json);
}

async function buildTwitterPostDataFromRapidApi(
  handle: string,
  json: any,
): Promise<PostData<AnySnsMetadata>[]> {
  const items: any[] = Array.isArray(json?.timeline) ? json.timeline : [];

const out: PostData<AnySnsMetadata>[] = [];

for (const item of items) {
  const postId = String(item?.tweet_id ?? "");
  const username = String(item?.author?.screen_name ?? "unknown");
  const postUrl = postId ? `https://x.com/${username}/status/${postId}` : "";

  const rawMedia = item?.media ?? {};

const mediaUrls: string[] = [];

// Handle photos
if (Array.isArray(rawMedia.photo)) {
  for (const photo of rawMedia.photo) {
    const url = photo?.media_url_https ?? photo?.url;
    if (url) mediaUrls.push(url);
  }
}

// Handle videos — pick the highest bitrate variant
if (Array.isArray(rawMedia.video)) {
  for (const video of rawMedia.video) {
    const variants: any[] = video?.variants ?? [];
    const mp4Variants = variants.filter(
      (v) => v.content_type === "video/mp4" && v.bitrate != null
    );
    const best = mp4Variants.sort((a, b) => b.bitrate - a.bitrate)[0];
    const url = best?.url ?? variants[0]?.url;
    if (url) mediaUrls.push(url);
  }
}

// Handle animated GIFs if present
if (Array.isArray(rawMedia.animated_gif)) {
  for (const gif of rawMedia.animated_gif) {
    const variants: any[] = gif?.variants ?? [];
    const url = variants[0]?.url;
    if (url) mediaUrls.push(url);
  }
}

  if (!postId || !postUrl) continue;

  const files = await downloadFilesFromUrls(mediaUrls);

  out.push({
    postLink: {
      url: postUrl,
      metadata: { 
        platform: "twitter", 
        username, 
        id: postId 
      },
    },
    username,
    postID: postId,
    originalText: processText(item),
    timestamp: item?.created_at ? new Date(item.created_at) : undefined,
    files,
  });
}

  return out;
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
      try {
        posts = await fetchTwitterFeedRapidApi(connection.handle);
      } catch (err) {
        log.error({ err, handle: connection.handle }, "Failed to fetch Twitter feed");
        await interaction.editReply("Failed to fetch Twitter feed. Please try again.");
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
