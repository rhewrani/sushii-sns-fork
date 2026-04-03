/**
 * Instagram profile feed: RapidAPI list + hydrate to PostData (no DB / seen state).
 */
import { ApiUsageEndpoint, recordApiUsage } from "../../../apiUsage";
import config from "../../../config/config";
import logger from "../../../logger";
import type { AnySnsMetadata, InstagramMetadata, PostData } from "../../../platforms/base";
import { tryWithFallbacks } from "../../../utils/fallback";
import { isDevMode, loadMockJson } from "../runtime";
import type { DownloadFilesFromUrls } from "../fetch";
import { fetchInstagramStories } from "./instagram-story";

const log = logger.child({ module: "monitor/fetch/instagram" });

/**
 * Normalized post node from RapidAPI /posts or Looter feed.
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
  singleMediaUrl?: string;
  isVideo?: boolean;
  carouselUrls?: string[];
}

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
    throw new Error("RapidAPI120 /posts returned unexpected response format");
  }

  if (rawNodes.length > 0 && rawNodes[0].urls) {
    log.warn("RapidAPI120 /posts returned pre-flattened items — carousel detection unavailable");
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

    if (
      node?.media_type === 8 ||
      node?.product_type === "carousel_container" ||
      !!node?.edge_sidecar_to_children ||
      !!node?.carousel_media
    ) {
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

export function parseRapidApiPostsResponseLooter(json: any): NormalizedFeedNode[] {
  const edges = json?.data?.user?.edge_owner_to_timeline_media?.edges;

  if (!Array.isArray(edges)) {
    log.error({
      rootKeys: Object.keys(json ?? {}),
      dataKeys: json?.data ? Object.keys(json.data) : "no data",
      userKeys: json?.data?.user ? Object.keys(json.data.user) : "no user",
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

    const isCarousel =
      node.__typename === "GraphSidecar" ||
      !!node.edge_sidecar_to_children;

    if (isCarousel) {
      const children = node.edge_sidecar_to_children?.edges;

      if (Array.isArray(children) && children.length > 0) {
        const carouselUrls = children
          .map((child: any) => {
            const slide = child.node;
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
 * List-only: RapidAPI120 /posts → normalized feed nodes.
 */
async function listIgProfilePostsViaRapidApi120(
  igUsername: string,
): Promise<NormalizedFeedNode[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi.json");
    return parseRapidApiPostsResponse120(mock);
  }

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
    }

    log.error(
      {
        status: res.status,
        statusText: res.statusText,
        errorBody,
        url: req.url,
      },
      "RapidAPI120 /posts failed",
    );

    throw new Error(
      `RapidAPI120 /posts failed: ${res.status} ${res.statusText} - ${typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)}`,
    );
  }

  const rawJson = await res.json();
  return parseRapidApiPostsResponse120(rawJson);
}

/**
 * List-only: RapidAPI-Looter /user-feeds2 → normalized feed nodes.
 */
async function listIgProfilePostsViaRapidApiLooter(
  igUsername: string,
  igId: string,
): Promise<NormalizedFeedNode[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-post-rapidapi-looter.json");
    return parseRapidApiPostsResponseLooter(mock);
  }

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
    let errorBody: string | object = "Unknown error";
    try {
      const clonedRes = res.clone();
      errorBody = await clonedRes.text();
      try {
        errorBody = JSON.parse(errorBody as string);
      } catch {
      }
    } catch {
    }

    log.error(
      {
        status: res.status,
        statusText: res.statusText,
        errorBody,
        url: req.url,
      },
      "RapidAPI-Looter /user-feeds2 failed",
    );

    throw new Error(
      `RapidAPI-Looter /user-feeds2 failed: ${res.status} ${res.statusText} - ${typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)}`,
    );
  }

  const rawJson = await res.json();
  return parseRapidApiPostsResponseLooter(rawJson);
}

/**
 * Download media for one feed node and build PostData (no seen state).
 */
async function hydrateIgFeedNode(
  node: NormalizedFeedNode,
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<InstagramMetadata> | null> {
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
    return null;
  }

  if (mediaUrls.length === 0) return null;

  const files = await downloadFilesFromUrls(mediaUrls);

  return {
    postLink: {
      url: postUrl,
      metadata: { platform: "instagram" as const, shortcode },
    },
    username: meta.username || igUsername,
    postID: shortcode,
    originalText: meta.title || "",
    timestamp: meta.takenAt ? new Date(meta.takenAt * 1000) : undefined,
    files,
  };
}

async function orchestrateIgProfileNodes(
  nodes: NormalizedFeedNode[],
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  const limit = options?.limit ?? Infinity;
  const seenChecker = options?.isPostSeen;
  const markSeen = options?.markPostSeen;

  const unseenNodes = nodes.filter((n) => !seenChecker?.(n.shortcode));

  if (markSeen) {
    for (const node of unseenNodes) {
      markSeen(node.shortcode);
    }
  }

  const nodesToDownload = unseenNodes.slice(0, limit);
  const postDatas: PostData<InstagramMetadata>[] = [];

  for (const node of nodesToDownload) {
    const p = await hydrateIgFeedNode(node, igUsername, downloadFilesFromUrls);
    if (p) postDatas.push(p);
  }

  return postDatas;
}

/**
 * Fetch Instagram profile posts with fallbacks (orchestrator: filter + mark + hydrate).
 */
async function fetchIgProfilePosts(
  igUsername: string,
  igId: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<InstagramMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI-Looter /user-feeds2",
      fn: async () => {
        const nodes = await listIgProfilePostsViaRapidApiLooter(igUsername, igId);
        return orchestrateIgProfileNodes(nodes, igUsername, downloadFilesFromUrls, options);
      },
    },
    {
      name: "RapidAPI120 /posts",
      fn: async () => {
        const nodes = await listIgProfilePostsViaRapidApi120(igUsername);
        return orchestrateIgProfileNodes(nodes, igUsername, downloadFilesFromUrls, options);
      },
    },
  ]);
}

export async function fetchInstagramConnectionPosts(
  igUsername: string,
  igId: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const [profilePosts, storyPosts] = await Promise.all([
    fetchIgProfilePosts(igUsername, igId, downloadFilesFromUrls, options),
    fetchInstagramStories(igUsername, downloadFilesFromUrls, options),
  ]);

  return [...profilePosts, ...storyPosts] as PostData<AnySnsMetadata>[];
}