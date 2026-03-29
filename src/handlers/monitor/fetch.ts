/**
 * Monitor polling: Instagram/TikTok/Twitter feeds, review creation, and `/fetch-all` sync.
 * Large module — new code should prefer small helpers in separate files to avoid growing this further.
 */
import type { Database } from "bun:sqlite";
import {
  AttachmentBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import { ApiUsageEndpoint, recordApiUsage } from "../../apiUsage";
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
import { sendOpsAlert } from "../../utils/opsAlert";
import { convertHeicToJpeg } from "../../utils/heic";
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { buildInlineFormatContent } from "../../utils/template";
import type { MonitorsConfig } from "./config";
import { findConnectionById, getConnectionId } from "./config";
import { isDevMode, loadMockJson } from "./runtime";
import {
  isPostSeen,
  getConnectionDb,
  markPostSeen,
  upsertConnectionMeta,
} from "./db";
import { batchToMessageOptions, buildReviewBatches } from "./embed";
import { createReview, deleteReview, type ReviewState } from "./review";

const log = logger.child({ module: "monitor/fetch" });

const downloader = new InstagramPostDownloader();

// Guard against concurrent fetches for the same username (double-click race condition)
const fetchingInProgress = new Set<string>();

async function fetchInstagramConnectionPosts(
  igUsername: string,
  igId: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
    /** If true, story items are marked seen without downloading media */
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const [profilePosts, storyPosts] = await Promise.all([
    fetchIgProfilePosts(igUsername, igId, options),
    fetchInstagramStories(igUsername, options),
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
function parseRapidApiPostsResponse120(json: any): NormalizedFeedNode[] {
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
    // log.error({ responseKeys: Object.keys(json ?? {}) }, "Unknown RapidAPI120 /posts response shape");
    throw new Error("RapidAPI120 /posts returned unexpected response format");
  }

  // If this looks like it already has the flattened `urls` shape (pre-processed),
  // we can't use it here — this path only handles raw GraphQL/node shapes.
  if (rawNodes.length > 0 && rawNodes[0].urls) {
    log.warn("RapidAPI120 /posts returned pre-flattened items — carousel detection unavailable");
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
 * Fetch all posts for an Instagram profile via RapidAPI /posts endpoint.
 * Carousel posts are detected in the feed and fetched individually via mediaByShortcode
 * since the /posts endpoint does not include carousel children.
 */
async function fetchIgProfilePostsViaRapidApi120(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  let feedNodes: NormalizedFeedNode[];

  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi.json");
    feedNodes = parseRapidApiPostsResponse120(mock);
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
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG120_POSTS);
    if (!res.ok) {
      let errorBody: string | object = "Unknown error";
      try {
        const clonedRes = res.clone();
        errorBody = await clonedRes.text();
        try {
          errorBody = JSON.parse(errorBody as string);
        } catch {
        }
      } catch {
        // Fallback if we can't read the body
      }

      log.error(
        {
          status: res.status,
          statusText: res.statusText,
          errorBody,
          url: req.url
        },
        "RapidAPI120 /posts failed"
      );

      throw new Error(
        `RapidAPI120 /posts failed: ${res.status} ${res.statusText} - ${typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)}`
      );
    }

    const rawJson = await res.json();
    feedNodes = parseRapidApiPostsResponse120(rawJson);
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

    if (node.carouselUrls?.length) {
      mediaUrls = node.carouselUrls;
    } else if (node.singleMediaUrl) {
      mediaUrls = [node.singleMediaUrl];
    } else {
      if (node.isCarousel) {
        log.error({ shortcode, node }, "Carousel flagged but no URLs - unexpected RapidAPI response");
      }
      continue;
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


function parseRapidApiPostsResponseLooter(json: any): NormalizedFeedNode[] {
  const edges = json?.data?.user?.edge_owner_to_timeline_media?.edges;

  if (!Array.isArray(edges)) {
    log.error({
      rootKeys: Object.keys(json ?? {}),
      dataKeys: json?.data ? Object.keys(json.data) : 'no data',
      userKeys: json?.data?.user ? Object.keys(json.data.user) : 'no user',
    }, "Unknown RapidAPI-Looter /user-feeds2 response shape");
    throw new Error("RapidAPI-Looter /user-feeds2 returned unexpected response format");
  }

  const nodes: NormalizedFeedNode[] = [];

  for (const edge of edges) {
    const node = edge.node;
    if (!node) continue;

    const shortcode = node.shortcode;
    if (!shortcode) continue;

    const meta = {
      title: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
      sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
      shortcode,
      username: node.owner?.username,
      takenAt: node.taken_at_timestamp,
    };

    // Carousel: __typename === "GraphSidecar" or has edge_sidecar_to_children
    const isCarousel =
      node.__typename === "GraphSidecar" ||
      !!node.edge_sidecar_to_children;

    if (isCarousel) {
      const children = node.edge_sidecar_to_children?.edges;

      if (Array.isArray(children) && children.length > 0) {
        const carouselUrls = children
          .map((child: any) => {
            const slide = child.node;
            // Video slide has video_url, image has display_url
            return slide.video_url ?? slide.display_url;
          })
          .filter((u: unknown): u is string => typeof u === "string" && u.length > 0);

        if (carouselUrls.length > 0) {
          nodes.push({ shortcode, isCarousel: false, meta, carouselUrls });
          continue;
        }
      }

      log.warn({ shortcode }, "Carousel detected but no children found");
      continue;
    }

    // Single media
    const mediaUrl = node.video_url ?? node.display_url;
    if (!mediaUrl) {
      log.warn({ shortcode }, "No media URL found, skipping");
      continue;
    }

    nodes.push({
      shortcode,
      isCarousel: false,
      meta,
      singleMediaUrl: mediaUrl,
      isVideo: node.is_video === true,
    });
  }

  return nodes;
}

/**
 * Fetch all posts for an Instagram profile via RapidAPI /user-feeds2 endpoint.
 * Carousel posts are detected in the feed and fetched individually via mediaByShortcode
 * since the /user-feeds2 endpoint does not include carousel children.
 */
async function fetchIgProfilePostsViaRapidApiLooter(
  igUsername: string,
  igId: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  let feedNodes: NormalizedFeedNode[];

  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi-looter.json");
    feedNodes = parseRapidApiPostsResponseLooter(mock);
  } else {
    const req = new Request(
      `https://instagram-looter2.p.rapidapi.com/user-feeds2?id=${igId}&count=4`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
          "x-rapidapi-key": config.RAPID_API_KEY,
        },
      },
    );

    const res = await fetch(req);
    recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG_LOOTER_USER_FEEDS2);
    if (!res.ok) {
      // Capture the actual error message from RapidAPI
      let errorBody: string | object = "Unknown error";
      try {
        const clonedRes = res.clone(); // Clone so we can read body without consuming original
        errorBody = await clonedRes.text();
        // Try to parse as JSON for structured error info
        try {
          errorBody = JSON.parse(errorBody as string);
        } catch {
          // Keep as text if not valid JSON
        }
      } catch {
        // Fallback if we can't read the body
      }

      log.error(
        {
          status: res.status,
          statusText: res.statusText,
          errorBody,
          url: req.url
        },
        "RapidAPI-Looter /user-feeds2 failed"
      );

      throw new Error(
        `RapidAPI-Looter /user-feeds2 failed: ${res.status} ${res.statusText} - ${typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)}`
      );
    }

    const rawJson = await res.json();
    feedNodes = parseRapidApiPostsResponseLooter(rawJson);
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

    if (node.carouselUrls?.length) {
      mediaUrls = node.carouselUrls;
    } else if (node.singleMediaUrl) {
      mediaUrls = [node.singleMediaUrl];
    } else {
      if (node.isCarousel) {
        log.error({ shortcode, node }, "Carousel flagged but no URLs - unexpected RapidAPI response");
      }
      continue;
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
 * Fetch Instagram profile posts with fallbacks.
 * NOTE: Brightdata is excluded — dataset gd_lk5ns7kz21pck8jpis only accepts
 * individual post URLs, not profile URLs, so it always returns empty post_content
 * for profile polling. It is only used for single-post downloads.
 */
export async function fetchIgProfilePosts(
  igUsername: string,
  igId: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI-Looter /user-feeds2", // private data + real-time data
      fn: () => fetchIgProfilePostsViaRapidApiLooter(igUsername, igId, options),
    },
    {
      name: "RapidAPI120 /posts", // only private data, not real-time
      fn: () => fetchIgProfilePostsViaRapidApi120(igUsername, options),
    },
    // {
    //   name: "Brightdata /posts", // public data
    //   fn: () => fetchIgProfilePostsViaBrightdata(igUsername),
    // },
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

/**
 * Fetch Instagram stories with fallbacks.
 * Primary: RapidAPI stories.
 */
async function fetchInstagramStories(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI stories",
      fn: () => fetchInstagramStoriesViaRapidApi(igUsername, options),
    },
  ]);
}

async function fetchInstagramStoriesViaRapidApi(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-stories.json");
    const items: any[] = Array.isArray(mock?.result) ? mock.result : [];
    return buildStoryPostDataFromRapidApi(igUsername, items, options);
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
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_IG120_STORIES_FEED);
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

  return buildStoryPostDataFromRapidApi(igUsername, items, options);
}


async function buildStoryPostDataFromRapidApi(
  igUsername: string,
  items: any[],
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const { isPostSeen, markPostSeen, storiesMarkSeenOnly } = options ?? {};

  if (storiesMarkSeenOnly) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const storyId = String(item?.id ?? item?.pk ?? `story-${igUsername}-${i}`);
      const postID = `ig-story:${igUsername}:${storyId}`;
      if (isPostSeen?.(postID)) continue;
      markPostSeen?.(postID);
    }
    return [];
  }

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

    const storyId = String(item?.id ?? item?.pk ?? `story-${igUsername}-${i}`);
    const postID = `ig-story:${igUsername}:${storyId}`;

    // Skip if already seen
    if (isPostSeen?.(postID)) {
      continue;
    }

    // Mark as seen immediately
    markPostSeen?.(postID);

    const files = await downloadFilesFromUrls([mediaUrls[0]]);

    out.push({
      postLink: {
        url: `https://www.instagram.com/${igUsername}/`,
        metadata: { platform: "instagram-story" as const },
      },
      username: igUsername,
      postID: postID,
      originalText: "",
      timestamp: item?.taken_at ? new Date(Number(item.taken_at) * 1000) : undefined,
      files,
    });
  }

  return out;
}

/**
 * Fetch Tiktok feed with fallbacks.
 * Primary: RapidAPI stories.
 */
async function fetchTiktokFeed(
  igUsername: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI best experience",
      fn: () => fetchTiktokFeedRapidApiBestExperience(igUsername, options),
    },
    {
      name: "RapidAPI tiktok api",
      fn: () => fetchTiktokFeedRapidApi2(igUsername, options),
    },
  ]);
}

async function fetchTiktokFeedRapidApiBestExperience(
  handle: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("tiktok-feed.json");
    return buildTiktokPostDataFromRapidApiBestExperience(handle, mock, options);
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
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_TIKTOK_BEST_USER_FEED);
  if (!res.ok) {
    throw new Error(`Failed to fetch tiktok feed (${res.status})`);
  }

  const json: any = await res.json();

  const awemeList = json?.data?.aweme_list;
  const isEmptyResponse = 
    !Array.isArray(awemeList) || 
    awemeList.length === 0 ||
    json?.status !== "ok";

  if (isEmptyResponse) {
    log.warn(
      { handle, status: json?.status, awemeCount: awemeList?.length },
      "TikTok Best Experience API returned empty feed — triggering fallback"
    );
    // Throw to cascade to next fallback provider in tryWithFallbacks
    throw new Error("TikTok Best Experience API returned empty aweme_list");
  }

  return buildTiktokPostDataFromRapidApiBestExperience(handle, json, options);
}

async function buildTiktokPostDataFromRapidApiBestExperience(
  handle: string,
  json: any,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const { isPostSeen, markPostSeen, limit = Infinity } = options ?? {};
  const awemeList: any[] = Array.isArray(json?.data?.aweme_list)
    ? json.data.aweme_list
    : [];

  const unseenAwemes = awemeList.filter(aweme => {
    const id = String(aweme?.aweme_id ?? "");
    return !id || !isPostSeen?.(id);
  });

  for (const aweme of unseenAwemes) {
    const id = String(aweme?.aweme_id ?? "");
    if (id) markPostSeen?.(id);
  }

  const toProcess = unseenAwemes.slice(0, limit);

  const out: PostData<AnySnsMetadata>[] = [];
  for (const aweme of toProcess) {
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

async function fetchTiktokFeedRapidApi2(
  handle: string,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("tiktok-feed.json");
    return buildTiktokPostDataFromRapidApi2(handle, mock, options);
  }

  const req = new Request(
    `https://tiktok-api6.p.rapidapi.com/user/videos?username=${encodeURIComponent(handle)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "tiktok-api6.p.rapidapi.com",
        "x-rapidapi-key": config.RAPID_API_KEY,
      },
    },
  );

  const res = await fetch(req);
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_TIKTOK_API6_USER_VIDEOS);
  if (!res.ok) {
    throw new Error(`Failed to fetch tiktok feed (${res.status})`);
  }

  const json: any = await res.json();
  return buildTiktokPostDataFromRapidApi2(handle, json, options);
}

async function buildTiktokPostDataFromRapidApi2(
  handle: string,
  json: any,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const { isPostSeen, markPostSeen, limit = Infinity } = options ?? {};

  const videoList: any[] = Array.isArray(json?.videos) ? json.videos : [];

  const unseenVideos = videoList.filter(video => {
    const id = String(video?.video_id ?? "");
    return !id || !isPostSeen?.(id);
  });

  for (const video of unseenVideos) {
    const id = String(video?.video_id ?? "");
    if (id) markPostSeen?.(id);
  }

  const toProcess = unseenVideos.slice(0, limit);

  const out: PostData<AnySnsMetadata>[] = [];

  for (const video of toProcess) {
    const videoId = String(video?.video_id ?? "");
    if (!videoId) continue;

    // console.log(`🔍 Processing (limited) video ${videoId} with limit ${limit}:`, {
    //   description: video?.description?.slice(0, 30)
    // });
    const mediaUrl = video?.unwatermarked_download_url ?? video?.download_url;
    if (!mediaUrl) continue;

    const imageUrls: string[] = Array.isArray(video?.images) && video.images.length > 0
      ? video.images
        .map((img: any) => img?.url ?? img?.display_url)
        .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      : [];

    const mediaUrls = mediaUrl ? [mediaUrl] : imageUrls;
    if (mediaUrls.length === 0) continue;

    const files = await downloadFilesFromUrls(mediaUrls);

    // Enforce mp4 extension for videos
    if (mediaUrl && !imageUrls.length && files.length > 0) {
      files[0].ext = "mp4";
    }

    const username = video?.author || handle;

    // Build post URL
    let postUrl = video?.share_url || `https://www.tiktok.com/@${username}/video/${videoId}`;
    if (postUrl.includes("?")) {
      postUrl = postUrl.substring(0, postUrl.indexOf("?"));
    }


    out.push({
      postLink: {
        url: postUrl,
        metadata: { platform: "tiktok" as const, videoId },
      },
      username,
      postID: videoId,
      originalText: video?.description || "",
      timestamp: video?.create_time ? new Date(Number(video.create_time) * 1000) : undefined,
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
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("twitter-feed.json");
    return buildTwitterPostDataFromRapidApi(handle, mock, options);
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
  recordApiUsage(ApiUsageEndpoint.RAPIDAPI_TWITTER45_TIMELINE);
  if (!res.ok) {
    throw new Error(`Failed to fetch twitter feed (${res.status})`);
  }

  const json: any = await res.json();
  return buildTwitterPostDataFromRapidApi(handle, json, options);
}

async function buildTwitterPostDataFromRapidApi(
  handle: string,
  json: any,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const { isPostSeen, markPostSeen, limit = Infinity } = options ?? {};
  const items: any[] = Array.isArray(json?.timeline) ? json.timeline : [];

  const unseenItems = items.filter(item => {
    const id = String(item?.tweet_id ?? "");
    return !id || !isPostSeen?.(id);
  });

  for (const item of unseenItems) {
    const id = String(item?.tweet_id ?? "");
    if (id) markPostSeen?.(id);
  }

  const toProcess = unseenItems.slice(0, limit);

  const out: PostData<AnySnsMetadata>[] = [];

  for (const item of toProcess) {
    const postId = String(item?.tweet_id ?? "");
    const username = String(item?.author?.screen_name ?? "unknown");
    const postUrl = postId ? `https://x.com/${username}/status/${postId}` : "";

    if (!postId || !postUrl) continue;  // Check EARLY

    const rawMedia = item?.media ?? {};
    const mediaUrls: string[] = [];

    // Handle photos
    if (Array.isArray(rawMedia.photo)) {
      for (const photo of rawMedia.photo) {
        const url = photo?.media_url_https ?? photo?.url;
        if (url) mediaUrls.push(url);
      }
    }

    // Handle videos
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

    // Handle animated GIFs
    if (Array.isArray(rawMedia.animated_gif)) {
      for (const gif of rawMedia.animated_gif) {
        const variants: any[] = gif?.variants ?? [];
        const url = variants[0]?.url;
        if (url) mediaUrls.push(url);
      }
    }

    // FIX: Don't skip text-only posts - allow empty mediaUrls
    const files = mediaUrls.length > 0
      ? await downloadFilesFromUrls(mediaUrls)
      : [];  // Empty files array for text-only posts

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
      files,  // Can be empty for text-only
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    const MAX_STORIES_PER_POLL = 10;

    let posts: PostData<AnySnsMetadata>[] = [];
    if (connection.type === "instagram") {
      try {
        if (!connection.igId) {
          await interaction.editReply("Instagram ID not configured for this connection.");
          return;
        }

        posts = await fetchInstagramConnectionPosts(connection.handle, connection.igId, {
          isPostSeen: (id) => isPostSeen(connectionDb, id),
          markPostSeen: (id) => markPostSeen(connectionDb, id),
          limit: MAX_REVIEWS_PER_POLL,
        });
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
        posts = await fetchTiktokFeed(connection.handle, {
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
        posts = await fetchTwitterFeedRapidApi(connection.handle, {
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

    // Posts returned are already filtered to unseen and capped at MAX_REVIEWS_PER_POLL
    // by the fetch layer (which also skips downloading media for posts beyond the limit).
    // For non-Instagram platforms (tiktok/twitter) which don't support the options yet,
    // filter unseen here as a fallback.

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
      // Stories are exempt from the MAX_REVIEWS_PER_POLL cap
      const isInstagramStory = (p: PostData<AnySnsMetadata>): boolean =>
        p.postLink?.metadata?.platform === "instagram-story";

      stories = newPosts.filter(isInstagramStory);
      regularPosts = newPosts.filter(p => !isInstagramStory(p));
      // Cap regular posts at MAX_REVIEWS_PER_POLL, but include ALL stories
      postsToReview = [
        ...stories.slice(0, MAX_STORIES_PER_POLL),
        ...regularPosts.slice(0, MAX_REVIEWS_PER_POLL)
      ];
    } else {
      // For non-Instagram platforms, apply the cap to all posts (unchanged)
      postsToReview = newPosts.slice(0, MAX_REVIEWS_PER_POLL);
    }

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
        messageIds: [],
      };

      const reviewId = createReview(reviewState);

      try {
        // Build all message batches (images first, controls last)
        const batches = buildReviewBatches(reviewState, reviewId);
        const messageIds: string[] = [];

        for (const batch of batches) {
          const msg = await (reviewChannel as SendableChannels).send(
            batchToMessageOptions(batch)
          );
          messageIds.push(msg.id);
        }

        // Store all message IDs so handlers can delete/update them
        reviewState.messageIds = messageIds;

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

    if (connection.type === "instagram") {
      await interaction.editReply(
        `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"} (${stories.length} story${stories.length === 1 ? "" : "s"} + ${regularPosts.slice(0, MAX_REVIEWS_PER_POLL).length} post${regularPosts.slice(0, MAX_REVIEWS_PER_POLL).length === 1 ? "" : "s"}). Review messages created below.`,
      );
    } else {
      await interaction.editReply(
        `Found ${reviewCount} new post${reviewCount === 1 ? "" : "s"}. Review messages created below.`,
      );
    }
  } finally {
    fetchingInProgress.delete(connectionId);
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
        await fetchInstagramConnectionPosts(connection.handle, connection.igId, {
          ...shared,
          limit: 0,
          storiesMarkSeenOnly: true,
        });
      } else if (connection.type === "tiktok") {
        await fetchTiktokFeed(connection.handle, {
          ...shared,
          limit: 0,
        });
      } else if (connection.type === "twitter") {
        await fetchTwitterFeedRapidApi(connection.handle, {
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


//
// UNCOMMENT IF WE EVER NEED TO USE BRIGHTDATA AGAIN
// CAUTION: BROKEN FUNCTION, NEED TO ADJUST PARSING OF RESPONSE
//

/**
 * Fetch all posts for an Instagram profile via the Brightdata API.
 * Uses the same dataset ID as the post downloader but with a profile URL payload.
 */
// async function fetchIgProfilePostsViaBrightdata(
//   igUsername: string,
// ): Promise<PostData<InstagramMetadata>[]> {
//   if (isDevMode()) {
//     const mockRaw = loadMockJson<any>("instagram-posts.json");
//     const mockPosts: InstagramPostElement[] = Array.isArray(mockRaw)
//       ? mockRaw
//       : Array.isArray(mockRaw?.posts)
//         ? mockRaw.posts
//         : Array.isArray(mockRaw?.data)
//           ? mockRaw.data
//           : Array.isArray(mockRaw?.result)
//             ? mockRaw.result
//             : [];
//     const postDatasRaw = await Promise.all(
//       mockPosts.map((p) => buildPostData(p, igUsername)),
//     );
//     return postDatasRaw.filter(
//       (x): x is PostData<InstagramMetadata> => x !== null,
//     );
//   }

//   const profileUrl = `https://www.instagram.com/${igUsername}/`;

//   const triggerReq = new Request(
//     "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_lk5ns7kz21pck8jpis&include_errors=true&type=discover_new&discover_by=url",
//     {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: `Bearer ${config.BD_API_TOKEN}`,
//       },
//       body: JSON.stringify([{ url: profileUrl, num_of_posts: 4 }]),
//     },
//   );

//   const triggerRes = await fetch(triggerReq);
//   if (triggerRes.status !== 200 && triggerRes.status !== 202) {
//     throw new Error(
//       `Failed to trigger IG profile fetch: ${triggerRes.status}`,
//     );
//   }

//   const triggerJson = await triggerRes.json();
//   const triggerParsed = BdTriggerResponseSchema.parse(triggerJson);

//   if (!triggerParsed.snapshot_id) {
//     throw new Error("No snapshot_id in trigger response");
//   }

//   const snapshotId = triggerParsed.snapshot_id;

//   log.debug({ igUsername, snapshotId }, "Waiting for IG profile snapshot");
//   await downloader.waitUntilDataReady(snapshotId, 120_000);

//   const posts = await downloader.fetchAllSnapshotData(snapshotId);

//   log.debug(
//     {
//       totalRecords: posts.length,
//       sample: posts.slice(0, 3).map((p) => ({
//         post_id: p.post_id,
//         url: p.url,
//         post_content_length: p.post_content?.length ?? 0,
//         keys: Object.keys(p),
//       })),
//     },
//     "Brightdata raw snapshot records",
//   );

//   // Brightdata may return one record per carousel slide (same post_id, different
//   // post_content entry) OR one record per post with all slides in post_content.
//   // Normalise to the latter before building PostData so all files end up together.
//   const groupedByPostId = new Map<string, InstagramPostElement>();
//   for (const post of posts) {
//     console.log(post.post_id);
//     const id = post.post_id || post.url || "";
//     const existing = groupedByPostId.get(id);
//     if (existing) {
//       // Merge post_content arrays so all carousel slides are in one element
//       existing.post_content = [
//         ...(existing.post_content ?? []),
//         ...(post.post_content ?? []),
//       ];
//     } else {
//       groupedByPostId.set(id, { ...post, post_content: [...(post.post_content ?? [])] });
//     }
//   }

//   const mergedPosts = Array.from(groupedByPostId.values());
//   const postDatasRaw = await Promise.all(
//     mergedPosts.map((p) => buildPostData(p, igUsername)),
//   );
//   const postDatas = postDatasRaw.filter(
//     (x): x is PostData<InstagramMetadata> => x !== null,
//   );

//   return mergePostDatasById(postDatas);
// }

/**
 * Merge multiple PostData objects with the same postID into single objects.
 * This is crucial for handling carousels that are returned as multiple records.
 */
// function mergePostDatasById<T extends AnySnsMetadata>(
//   postDatas: PostData<T>[],
// ): PostData<T>[] {
//   const merged = new Map<string, PostData<T>>();

//   for (const post of postDatas) {
//     if (!post.postID) {
//       // If no ID, we can't merge, so just keep as-is with a fake ID
//       merged.set(`no-id-${Math.random()}`, post);
//       continue;
//     }

//     const existing = merged.get(post.postID);
//     if (existing) {
//       // Merge files
//       existing.files.push(...post.files);
//       // Keep the most informative metadata (prefer non-empty titles)
//       if (!existing.originalText && post.originalText) {
//         existing.originalText = post.originalText;
//       }
//       if (!existing.timestamp && post.timestamp) {
//         existing.timestamp = post.timestamp;
//       }
//     } else {
//       merged.set(post.postID, { ...post, files: [...post.files] });
//     }
//   }

//   return Array.from(merged.values());
// }