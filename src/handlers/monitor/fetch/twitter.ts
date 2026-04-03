/**
 * Twitter/X timeline: fetch JSON + hydrate tweet rows (no DB / seen state).
 */
import { ApiUsageEndpoint, recordApiUsage } from "../../../apiUsage";
import config from "../../../config/config";
import type { AnySnsMetadata, PostData } from "../../../platforms/base";
import { isDevMode, loadMockJson } from "../runtime";
import { selectUnseenMarkAllSlice, type DownloadFilesFromUrls } from "../fetch";

function processTwitterText(item: any): string {
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

async function fetchTwitterTimelineJson(handle: string): Promise<any> {
  if (isDevMode()) {
    return loadMockJson<any>("twitter-feed.json");
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

  return res.json();
}

async function hydrateTwitterTimelineItem(
  item: any,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<AnySnsMetadata> | null> {
  const postId = String(item?.tweet_id ?? "");
  const username = String(item?.author?.screen_name ?? "unknown");
  const postUrl = postId ? `https://x.com/${username}/status/${postId}` : "";

  if (!postId || !postUrl) return null;

  const rawMedia = item?.media ?? {};
  const mediaUrls: string[] = [];

  if (Array.isArray(rawMedia.photo)) {
    for (const photo of rawMedia.photo) {
      const url = photo?.media_url_https ?? photo?.url;
      if (url) mediaUrls.push(url);
    }
  }

  if (Array.isArray(rawMedia.video)) {
    for (const video of rawMedia.video) {
      const variants: any[] = video?.variants ?? [];
      const mp4Variants = variants.filter(
        (v) => v.content_type === "video/mp4" && v.bitrate != null,
      );
      const best = mp4Variants.sort((a, b) => b.bitrate - a.bitrate)[0];
      const url = best?.url ?? variants[0]?.url;
      if (url) mediaUrls.push(url);
    }
  }

  if (Array.isArray(rawMedia.animated_gif)) {
    for (const gif of rawMedia.animated_gif) {
      const variants: any[] = gif?.variants ?? [];
      const url = variants[0]?.url;
      if (url) mediaUrls.push(url);
    }
  }

  const files = mediaUrls.length > 0
    ? await downloadFilesFromUrls(mediaUrls)
    : [];

  return {
    postLink: {
      url: postUrl,
      metadata: {
        platform: "twitter",
        username,
        id: postId,
      },
    },
    username,
    postID: postId,
    originalText: processTwitterText(item),
    timestamp: item?.created_at ? new Date(item.created_at) : undefined,
    files,
  };
}

export async function fetchTwitterFeedRapidApi(
  handle: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    limit?: number;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const json = await fetchTwitterTimelineJson(handle);
  const items = Array.isArray(json?.timeline) ? json.timeline : [];
  const limit = options?.limit ?? Infinity;
  const toProcess = selectUnseenMarkAllSlice(
    items,
    (item: any) => String(item?.tweet_id ?? ""),
    options?.isPostSeen,
    options?.markPostSeen,
    limit,
  );
  const out: PostData<AnySnsMetadata>[] = [];
  for (const item of toProcess) {
    const p = await hydrateTwitterTimelineItem(item, downloadFilesFromUrls);
    if (p) out.push(p);
  }
  return out;
}
