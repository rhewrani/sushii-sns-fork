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
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
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
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const [profilePosts, storyPosts] = await Promise.all([
    fetchIgProfilePosts(igUsername, options),
    fetchInstagramStories(igUsername),
  ]);

  return [...profilePosts, ...storyPosts] as PostData<AnySnsMetadata>[];
}
/**
 * Represents a normalized post node extracted from the RapidAPI /posts feed.
 * Carousel posts are flagged so they can be fetched individually via mediaByShortcode.
 */
interface NormalizedFeedNode {
  shortcode: string;
  isCarousel: boolean;
  meta: {
    title: string;
    sourceUrl: string;
    shortcode: string;
    username: string | undefined;
    takenAt: number | undefined;
  };
  // Only populated for non-carousel posts
  singleMediaUrl?: string;
  isVideo?: boolean;
  // Populated for carousels that have inline carousel_media
  carouselUrls?: string[];
}

/**
 * Detect whether a raw feed node is a carousel.
 * The /posts endpoint does NOT include carousel children — it only signals the type.
 * media_type === 8 is Instagram's carousel type code.
 */
function isCarouselNode(node: any): boolean {
  return (
    node?.media_type === 8 ||
    node?.product_type === "carousel_container" ||
    !!node?.edge_sidecar_to_children ||
    !!node?.carousel_media
  );
}

/**
 * Parse the RapidAPI /posts response into normalized feed nodes.
 * Carousels are flagged for individual fetching; single posts get their media URL inline.
 */
function parseRapidApiPostsResponse(json: any): NormalizedFeedNode[] {
  let rawNodes: any[] | undefined;

  if (Array.isArray(json)) {
    rawNodes = json;
  } else if (Array.isArray(json?.data)) {
    rawNodes = json.data;
  } else if (Array.isArray(json?.result)) {
    rawNodes = json.result;
  } else if (Array.isArray(json?.result?.edges)) {
    rawNodes = json.result.edges.map((e: any) => e.node ?? e);
  } else if (Array.isArray(json?.items)) {
    rawNodes = json.items;
  }

  if (!rawNodes) {
    log.error({ responseKeys: Object.keys(json ?? {}) }, "Unknown RapidAPI /posts response shape");
    throw new Error("RapidAPI /posts returned unexpected response format");
  }

  // If this looks like it already has the flattened `urls` shape (pre-processed),
  // we can't use it here — this path only handles raw GraphQL/node shapes.
  if (rawNodes.length > 0 && rawNodes[0].urls) {
    log.warn("RapidAPI /posts returned pre-flattened items — carousel detection unavailable");
    // Best-effort: treat everything as single
    return rawNodes.flatMap((item: any) => {
      const shortcode = item.meta?.shortcode;
      if (!shortcode) return [];
      const url = item.urls?.[0]?.url;
      if (!url) return [];
      return [{
        shortcode,
        isCarousel: false,
        meta: item.meta,
        singleMediaUrl: url,
        isVideo: item.urls?.[0]?.extension === "mp4",
      }];
    });
  }

  const findMediaUrl = (obj: any): string | undefined =>
    obj?.video_url ??
    obj?.display_url ??
    obj?.thumbnail_src ??
    obj?.image_versions2?.candidates?.[0]?.url ??
    obj?.thumbnail_resources?.[obj.thumbnail_resources?.length - 1]?.src;

  const nodes: NormalizedFeedNode[] = [];

  for (const node of rawNodes) {
    const shortcode = node.shortcode ?? node.code;
    if (!shortcode) continue;

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

    if (isCarouselNode(node)) {
      // carousel_media contains all slides inline — extract them directly.
      // Each slide has image_versions2.candidates[0] (highest res) or video_versions[0].
      if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
        const carouselUrls = node.carousel_media
          .map((slide: any) => {
            const videoUrl = Array.isArray(slide.video_versions) && slide.video_versions.length > 0
              ? slide.video_versions[0]?.url
              : undefined;
            const imageUrl = slide.image_versions2?.candidates?.[0]?.url;
            return videoUrl ?? imageUrl;
          })
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0);

        if (carouselUrls.length > 0) {
          log.debug({ shortcode, slideCount: carouselUrls.length }, "Extracted carousel slides from feed inline");
          nodes.push({ shortcode, isCarousel: false, meta, carouselUrls });
          continue;
        }
      }

      // carousel_media missing or empty — fall back to individual fetch
      log.debug({ shortcode }, "Carousel has no inline media — will fetch via mediaByShortcode");
      nodes.push({ shortcode, isCarousel: true, meta });
      continue;
    }

    const mediaUrl = findMediaUrl(node);
    if (!mediaUrl) {
      log.warn({ shortcode, nodeKeys: Object.keys(node) }, "Could not find media URL in node, skipping");
      continue;
    }

    nodes.push({
      shortcode,
      isCarousel: false,
      meta,
      singleMediaUrl: mediaUrl,
      isVideo: node.is_video === true || node.media_type === 2,
    });
  }

  return nodes;
}

/**
 * Fetch all media items for a shortcode via RapidAPI mediaByShortcode.
 * Used for carousel posts where the /posts feed only returns the cover image.
 */
async function fetchCarouselViaMediaByShortcode(shortcode: string): Promise<RapidApiMediaResponse> {
  const req = new Request(
    "https://instagram120.p.rapidapi.com/api/instagram/mediaByShortcode",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "instagram120.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
      body: JSON.stringify({ shortcode }),
    },
  );

  const res = await fetch(req);
  if (!res.ok) {
    throw new Error(`RapidAPI mediaByShortcode failed for ${shortcode} (${res.status})`);
  }

  const rawJson = await res.json();
  return RapidApiMediaResponseSchema.parse(rawJson);
}

/**
 * Fetch all posts for an Instagram profile via RapidAPI /posts endpoint.
 * Carousel posts are detected in the feed and fetched individually via mediaByShortcode
 * since the /posts endpoint does not include carousel children.
 */
async function fetchIgProfilePostsViaRapidApi(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  let feedNodes: NormalizedFeedNode[];

  if (!isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi.json");
    feedNodes = parseRapidApiPostsResponse(mock);
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
    feedNodes = parseRapidApiPostsResponse(rawJson);
  }

  const limit = options?.limit ?? Infinity;
  const seenChecker = options?.isPostSeen;
  const markSeen = options?.markPostSeen;

  // Separate unseen nodes from seen ones upfront — no downloading yet.
  const unseenNodes = feedNodes.filter((n) => !seenChecker?.(n.shortcode));

  // Mark ALL unseen nodes as seen immediately so future polls skip them,
  // even if we only download the first `limit` ones below.
  if (markSeen) {
    for (const node of unseenNodes) {
      markSeen(node.shortcode);
    }
  }

  // Only download media for the first `limit` unseen posts.
  const nodesToDownload = unseenNodes.slice(0, limit);
  const postDatas: PostData<InstagramMetadata>[] = [];

  for (const node of nodesToDownload) {
    const { shortcode, meta } = node;

    const postUrl = meta.sourceUrl ?? `https://www.instagram.com/p/${shortcode}/`;

    let mediaUrls: string[];

    if (node.carouselUrls && node.carouselUrls.length > 0) {
      // Carousel with slides already extracted inline from the feed response
      mediaUrls = node.carouselUrls;
    } else if (node.isCarousel) {
      // Carousel flagged but no inline data — fetch individually via mediaByShortcode
      try {
        const carouselItems = await fetchCarouselViaMediaByShortcode(shortcode);
        mediaUrls = carouselItems
          .flatMap((item) => item.urls.map((u) => u.url))
          .filter((u) => u.length > 0);
        log.debug({ shortcode, mediaCount: mediaUrls.length }, "Fetched carousel via mediaByShortcode");
      } catch (err) {
        log.error({ err, shortcode }, "Failed to fetch carousel via mediaByShortcode, skipping");
        continue;
      }
    } else {
      if (!node.singleMediaUrl) continue;
      mediaUrls = [node.singleMediaUrl];
    }

    if (mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls(mediaUrls);

    postDatas.push({
      postLink: {
        url: postUrl,
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
    const mockRaw = loadMockJson<any>("instagram-posts.json");
    const mockPosts: InstagramPostElement[] = Array.isArray(mockRaw)
      ? mockRaw
      : Array.isArray(mockRaw?.posts)
        ? mockRaw.posts
        : Array.isArray(mockRaw?.data)
          ? mockRaw.data
          : Array.isArray(mockRaw?.result)
            ? mockRaw.result
            : [];
    const postDatasRaw = await Promise.all(
      mockPosts.map((p) => buildPostData(p, igUsername)),
    );
    return postDatasRaw.filter(
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

  log.debug(
    {
      totalRecords: posts.length,
      sample: posts.slice(0, 3).map((p) => ({
        post_id: p.post_id,
        url: p.url,
        post_content_length: p.post_content?.length ?? 0,
        keys: Object.keys(p),
      })),
    },
    "Brightdata raw snapshot records",
  );

  // Brightdata may return one record per carousel slide (same post_id, different
  // post_content entry) OR one record per post with all slides in post_content.
  // Normalise to the latter before building PostData so all files end up together.
  const groupedByPostId = new Map<string, InstagramPostElement>();
  for (const post of posts) {
    const id = post.post_id || post.url || "";
    const existing = groupedByPostId.get(id);
    if (existing) {
      // Merge post_content arrays so all carousel slides are in one element
      existing.post_content = [
        ...(existing.post_content ?? []),
        ...(post.post_content ?? []),
      ];
    } else {
      groupedByPostId.set(id, { ...post, post_content: [...(post.post_content ?? [])] });
    }
  }

  const mergedPosts = Array.from(groupedByPostId.values());
  const postDatasRaw = await Promise.all(
    mergedPosts.map((p) => buildPostData(p, igUsername)),
  );
  const postDatas = postDatasRaw.filter(
    (x): x is PostData<InstagramMetadata> => x !== null,
  );

  return mergePostDatasById(postDatas);
}

/**
 * Fetch Instagram profile posts with fallbacks.
 * NOTE: Brightdata is excluded — dataset gd_lk5ns7kz21pck8jpis only accepts
 * individual post URLs, not profile URLs, so it always returns empty post_content
 * for profile polling. It is only used for single-post downloads.
 */
export async function fetchIgProfilePosts(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI /posts",
      fn: () => fetchIgProfilePostsViaRapidApi(igUsername, options),
    },
    {
      name: "Brightdata /posts",
      fn: () => fetchIgProfilePostsViaBrightdata(igUsername),
    },
    // TODO: Add a profile-capable provider as a fallback here
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

  log.debug(
    { postId: igPost.post_id, mediaCount: mediaUrls.length },
    "Downloading Brightdata post media",
  );

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

    const MAX_REVIEWS_PER_POLL = 3;

    let posts: PostData<AnySnsMetadata>[] = [];
    if (connection.type === "instagram") {
      try {
        posts = await fetchInstagramConnectionPosts(connection.handle, {
          isPostSeen: (id) => isPostSeen(connectionDb, id),
          markPostSeen: (id) => markPostSeen(connectionDb, id),
          limit: MAX_REVIEWS_PER_POLL,
        });
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

    // Posts returned are already filtered to unseen and capped at MAX_REVIEWS_PER_POLL
    // by the fetch layer (which also skips downloading media for posts beyond the limit).
    // For non-Instagram platforms (tiktok/twitter) which don't support the options yet,
    // filter unseen here as a fallback.

    let newPosts: PostData<AnySnsMetadata>[];
    if (connection.type === "instagram") {
      // Instagram fetch already filtered to unseen AND limited to MAX_REVIEWS_PER_POLL
      // It also marked ALL fetched posts as seen
      newPosts = posts;
    } else {
      // TikTok/Twitter don't have the seen-check in their fetch yet
      newPosts = posts.filter((p) => {
        if (!p.postID) return false;
        return !isPostSeen(connectionDb, p.postID);
      });
    }

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

    const postsToReview = newPosts.slice(0, MAX_REVIEWS_PER_POLL);

    const socialsChannelId = monitorsConfig.socials_channel_id;
    let reviewCount = 0;

    for (const postData of postsToReview) {
      if (!postData.postID) continue;

      // All filenames across all chunks — used for the dropdown (covers every image).
      const allFileNames = postData.files.map((f, i) => `media-${i}.${f.ext}`);
      const renderedContent = buildInlineFormatContent(monitorsConfig.template, postData as any);

      // Split into chunks of 10 for Discord's per-message attachment limit.
      const fileChunks = chunkArray(postData.files, MAX_ATTACHMENTS_PER_MESSAGE);

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
        overflowMessageIds: [],
      };

      const reviewId = createReview(reviewState);

      try {
        // Send the review embed FIRST — it has the text, gallery (images 1-10),
        // dropdown (all images), and action buttons.
        const firstChunk = fileChunks[0] ?? [];
        const firstAttachments = firstChunk.map((f, i) =>
          new AttachmentBuilder(f.buffer).setName(allFileNames[i]),
        );
        await (reviewChannel as SendableChannels).send(
          buildReviewMessage(reviewState, reviewId, firstAttachments),
        );

        // Send overflow chunks AFTER the review embed, labelled so it's clear
        // which post they belong to.
        const overflowMessageIds: string[] = [];
        for (let chunkIndex = 1; chunkIndex < fileChunks.length; chunkIndex++) {
          const chunk = fileChunks[chunkIndex];
          const startIndex = chunkIndex * MAX_ATTACHMENTS_PER_MESSAGE + 1;
          const endIndex = startIndex + chunk.length - 1;
          const attachments = chunk.map((f, i) =>
            new AttachmentBuilder(f.buffer).setName(
              allFileNames[chunkIndex * MAX_ATTACHMENTS_PER_MESSAGE + i],
            ),
          );
          const overflowMsg = await (reviewChannel as SendableChannels).send({
            content: `📎 **Images ${startIndex}–${endIndex}** (continued from review above)`,
            files: attachments,
          });
          overflowMessageIds.push(overflowMsg.id);
        }

        // Store overflow IDs so post/skip handlers can delete them
        reviewState.overflowMessageIds.push(...overflowMessageIds);

        reviewCount++;
        // markPostSeen is now called upfront in the fetch layer for all unseen posts,
        // so no need to call it here for Instagram. For safety (tiktok/twitter), keep it.
        if (postData.postID) markPostSeen(connectionDb, postData.postID);
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

/**
 * Merge multiple PostData objects with the same postID into single objects.
 * This is crucial for handling carousels that are returned as multiple records.
 */
function mergePostDatasById<T extends AnySnsMetadata>(
  postDatas: PostData<T>[],
): PostData<T>[] {
  const merged = new Map<string, PostData<T>>();

  for (const post of postDatas) {
    if (!post.postID) {
      // If no ID, we can't merge, so just keep as-is with a fake ID
      merged.set(`no-id-${Math.random()}`, post);
      continue;
    }

    const existing = merged.get(post.postID);
    if (existing) {
      // Merge files
      existing.files.push(...post.files);
      // Keep the most informative metadata (prefer non-empty titles)
      if (!existing.originalText && post.originalText) {
        existing.originalText = post.originalText;
      }
      if (!existing.timestamp && post.timestamp) {
        existing.timestamp = post.timestamp;
      }
    } else {
      merged.set(post.postID, { ...post, files: [...post.files] });
    }
  }

  return Array.from(merged.values());
}