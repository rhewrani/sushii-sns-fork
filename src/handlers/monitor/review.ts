import { randomUUID } from "crypto";
import type { InstagramMetadata, PostData } from "../../platforms/base";

// ---------------------------------------------------------------------------
// Custom ID prefixes (shared between embed.ts and interactions.ts)
// ---------------------------------------------------------------------------
export const MONITOR_FETCH_PREFIX = "monitor:fetch:";
export const REVIEW_REMOVE_PREFIX = "monitor:review:remove:";
export const REVIEW_EDIT_PREFIX = "monitor:review:edit:";
export const REVIEW_MODAL_PREFIX = "monitor:review:modal:";
export const REVIEW_POST_PREFIX = "monitor:review:post:";
export const REVIEW_SKIP_PREFIX = "monitor:review:skip:";

export interface ChannelConfig {
  channelId: string;
  format: "inline" | "links";
  template: string;
}

export interface ReviewState {
  postData: PostData<InstagramMetadata>;
  igUsername: string;
  removedIndices: Set<number>;
  customContent: string | null;
  renderedContent: string;
  channelConfigs: ChannelConfig[];
  fetcherUserId: string;
  fileNames: string[];
}

const REVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour — prevents file buffer leaks on abandoned reviews

const pendingReviews = new Map<string, ReviewState>();
const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function createReview(state: ReviewState): string {
  const reviewId = randomUUID();
  pendingReviews.set(reviewId, state);
  const timer = setTimeout(() => {
    pendingReviews.delete(reviewId);
    reviewTimers.delete(reviewId);
  }, REVIEW_TTL_MS);
  reviewTimers.set(reviewId, timer);
  return reviewId;
}

export function getReview(reviewId: string): ReviewState | undefined {
  return pendingReviews.get(reviewId);
}

export function updateReview(
  reviewId: string,
  updates: Partial<ReviewState>,
): void {
  const state = pendingReviews.get(reviewId);
  if (!state) return;
  pendingReviews.set(reviewId, { ...state, ...updates });
}

export function deleteReview(reviewId: string): void {
  pendingReviews.delete(reviewId);
  const timer = reviewTimers.get(reviewId);
  if (timer !== undefined) {
    clearTimeout(timer);
    reviewTimers.delete(reviewId);
  }
}
