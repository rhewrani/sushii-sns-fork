/**
 * TikTok feed: fetch JSON + hydrate aweme/video rows (no DB / seen state).
 */
import { ApiUsageEndpoint, recordApiUsage } from "../../../apiUsage";
import config from "../../../config/config";
import logger from "../../../logger";
import type { AnySnsMetadata, PostData } from "../../../platforms/base";
import { tryWithFallbacks } from "../../../utils/fallback";
import { isDevMode, loadMockJson } from "../runtime";
import { selectUnseenMarkAllSlice, type DownloadFilesFromUrls } from "../fetch";

const log = logger.child({ module: "monitor/fetch/tiktok" });

async function fetchTiktokBestExperienceJson(handle: string): Promise<any> {
  if (isDevMode()) {
    return loadMockJson<any>("tiktok-feed.json");
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

  return res.json();
}

async function fetchTiktokApi6Json(handle: string): Promise<any> {
  if (isDevMode()) {
    return loadMockJson<any>("tiktok-feed.json");
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

  return res.json();
}

async function processTiktokFeedItems<T>(
  items: T[],
  getId: (t: T) => string,
  hydrateItem: (item: T) => Promise<PostData<AnySnsMetadata> | null>,
  options:
    | {
        isPostSeen?: (id: string) => boolean;
        markPostSeen?: (id: string) => void;
        limit?: number;
      }
    | undefined,
  limit: number,
): Promise<PostData<AnySnsMetadata>[]> {
  const toProcess = selectUnseenMarkAllSlice(
    items,
    getId,
    options?.isPostSeen,
    options?.markPostSeen,
    limit,
  );
  const out: PostData<AnySnsMetadata>[] = [];
  for (const item of toProcess) {
    const p = await hydrateItem(item);
    if (p) out.push(p);
  }
  return out;
}

async function fetchTiktokFeedViaBestExperience(
  handle: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options:
    | {
        isPostSeen?: (id: string) => boolean;
        markPostSeen?: (id: string) => void;
        limit?: number;
      }
    | undefined,
  limit: number,
): Promise<PostData<AnySnsMetadata>[]> {
  const json = await fetchTiktokBestExperienceJson(handle);
  const awemeList = json?.data?.aweme_list;
  const isEmptyResponse =
    !Array.isArray(awemeList) ||
    awemeList.length === 0 ||
    json?.status !== "ok";

  if (isEmptyResponse) {
    log.warn(
      { handle, status: json?.status, awemeCount: awemeList?.length },
      "TikTok Best Experience API returned empty feed — triggering fallback",
    );
    throw new Error("TikTok Best Experience API returned empty aweme_list");
  }

  return processTiktokFeedItems(
    awemeList,
    (a: any) => String(a?.aweme_id ?? ""),
    (aweme: any) => hydrateTiktokAwemeBestExperience(handle, aweme, downloadFilesFromUrls),
    options,
    limit,
  );
}

async function fetchTiktokFeedViaApi6(
  handle: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options:
    | {
        isPostSeen?: (id: string) => boolean;
        markPostSeen?: (id: string) => void;
        limit?: number;
      }
    | undefined,
  limit: number,
): Promise<PostData<AnySnsMetadata>[]> {
  const json = await fetchTiktokApi6Json(handle);
  const videoList = Array.isArray(json?.videos) ? json.videos : [];
  return processTiktokFeedItems(
    videoList,
    (v: any) => String(v?.video_id ?? ""),
    (video: any) => hydrateTiktokVideoApi6(handle, video, downloadFilesFromUrls),
    options,
    limit,
  );
}

async function hydrateTiktokAwemeBestExperience(
  handle: string,
  aweme: any,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<AnySnsMetadata> | null> {
  const awemeId = String(aweme?.aweme_id ?? "");
  if (!awemeId) return null;

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
  if (mediaUrls.length === 0) return null;

  const files = await downloadFilesFromUrls(mediaUrls);

  if (videoUrls.length > 0 && files.length > 0) {
    files[0].ext = "mp4";
  }
  const username = aweme?.author?.unique_id || handle;
  let postUrl =
    aweme?.share_url || `https://www.tiktok.com/@${username}/video/${awemeId}`;

  if (postUrl.includes("?")) {
    postUrl = postUrl.substring(0, postUrl.indexOf("?"));
  }

  return {
    postLink: {
      url: postUrl,
      metadata: { platform: "tiktok" as const, videoId: awemeId },
    },
    username,
    postID: awemeId,
    originalText: aweme?.desc || "",
    timestamp: aweme?.create_time ? new Date(Number(aweme.create_time) * 1000) : undefined,
    files,
  };
}

async function hydrateTiktokVideoApi6(
  handle: string,
  video: any,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<AnySnsMetadata> | null> {
  const videoId = String(video?.video_id ?? "");
  if (!videoId) return null;

  const mediaUrl = video?.unwatermarked_download_url ?? video?.download_url;

  const imageUrls: string[] = Array.isArray(video?.images) && video.images.length > 0
    ? video.images
      .map((img: any) => img?.url ?? img?.display_url)
      .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
    : [];

  const mediaUrls = mediaUrl ? [mediaUrl] : imageUrls;
  if (mediaUrls.length === 0) return null;

  const files = await downloadFilesFromUrls(mediaUrls);

  if (mediaUrl && !imageUrls.length && files.length > 0) {
    files[0].ext = "mp4";
  }

  const username = video?.author || handle;

  let postUrl = video?.share_url || `https://www.tiktok.com/@${username}/video/${videoId}`;
  if (postUrl.includes("?")) {
    postUrl = postUrl.substring(0, postUrl.indexOf("?"));
  }

  return {
    postLink: {
      url: postUrl,
      metadata: { platform: "tiktok" as const, videoId },
    },
    username,
    postID: videoId,
    originalText: video?.description || "",
    timestamp: video?.create_time ? new Date(Number(video.create_time) * 1000) : undefined,
    files,
  };
}

export async function fetchTiktokFeed(
  handle: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const limit = options?.limit ?? Infinity;

  return tryWithFallbacks([
    {
      name: "RapidAPI best experience",
      fn: () =>
        fetchTiktokFeedViaBestExperience(handle, downloadFilesFromUrls, options, limit),
    },
    {
      name: "RapidAPI tiktok api",
      fn: () => fetchTiktokFeedViaApi6(handle, downloadFilesFromUrls, options, limit),
    },
  ]);
}
