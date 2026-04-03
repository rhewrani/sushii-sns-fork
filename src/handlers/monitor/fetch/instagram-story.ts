/**
 * Instagram stories: list API + hydrate (no DB / seen state).
 */
import { ApiUsageEndpoint, recordApiUsage } from "../../../apiUsage";
import config from "../../../config/config";
import type { AnySnsMetadata, PostData } from "../../../platforms/base";
import { tryWithFallbacks } from "../../../utils/fallback";
import { isDevMode, loadMockJson } from "../runtime";
import type { DownloadFilesFromUrls } from "../fetch";

/**
 * Flatten RapidAPI stories JSON into raw story items.
 */
function flattenInstagramStoryItems(json: any): any[] {
  const resultItems: any[] = Array.isArray(json?.result) ? json.result : [];
  const nestedItems: any[] = resultItems.flatMap((entry: any) => {
    if (Array.isArray(entry?.items)) return entry.items;
    if (Array.isArray(entry?.stories)) return entry.stories;
    if (Array.isArray(entry?.result)) return entry.result;
    return [];
  });
  return nestedItems.length > 0 ? nestedItems : resultItems;
}

async function listInstagramStoryItems(igUsername: string): Promise<any[]> {
  if (isDevMode()) {
    const mock = loadMockJson<any>("instagram-stories.json");
    return flattenInstagramStoryItems(mock);
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
  return flattenInstagramStoryItems(json);
}

function getStoryPostId(igUsername: string, item: any, index: number): string {
  const storyId = String(item?.id ?? item?.pk ?? `story-${igUsername}-${index}`);
  return `ig-story:${igUsername}:${storyId}`;
}

async function hydrateInstagramStoryItem(
  igUsername: string,
  item: any,
  index: number,
  downloadFilesFromUrls: DownloadFilesFromUrls,
): Promise<PostData<AnySnsMetadata> | null> {
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
  if (mediaUrls.length === 0) return null;

  const postID = getStoryPostId(igUsername, item, index);

  const files = await downloadFilesFromUrls([mediaUrls[0]]);

  return {
    postLink: {
      url: `https://www.instagram.com/${igUsername}/`,
      metadata: { platform: "instagram-story" as const },
    },
    username: igUsername,
    postID,
    originalText: "",
    timestamp: item?.taken_at ? new Date(Number(item.taken_at) * 1000) : undefined,
    files,
  };
}

async function fetchInstagramStoriesViaRapidApi(
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  const items = await listInstagramStoryItems(igUsername);
  const { isPostSeen: isSeen, markPostSeen: markSeen, storiesMarkSeenOnly } = options ?? {};

  if (storiesMarkSeenOnly) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const postID = getStoryPostId(igUsername, item, i);
      if (isSeen?.(postID)) continue;
      markSeen?.(postID);
    }
    return [];
  }

  const out: PostData<AnySnsMetadata>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const postID = getStoryPostId(igUsername, item, i);

    if (isSeen?.(postID)) {
      continue;
    }

    markSeen?.(postID);

    const p = await hydrateInstagramStoryItem(igUsername, item, i, downloadFilesFromUrls);
    if (p) out.push(p);
  }

  return out;
}

export async function fetchInstagramStories(
  igUsername: string,
  downloadFilesFromUrls: DownloadFilesFromUrls,
  options?: {
    isPostSeen?: (id: string) => boolean;
    markPostSeen?: (id: string) => void;
    storiesMarkSeenOnly?: boolean;
  },
): Promise<PostData<AnySnsMetadata>[]> {
  return tryWithFallbacks([
    {
      name: "RapidAPI stories",
      fn: () => fetchInstagramStoriesViaRapidApi(igUsername, downloadFilesFromUrls, options),
    },
  ]);
}
