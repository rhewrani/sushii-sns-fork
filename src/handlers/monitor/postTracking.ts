/**
 * Contract for recording that a post was sent to the socials channel (monitor_seen_posts).
 * Used by {@link sendPostToChannel} without importing SQLite from utils.
 */
export interface PostTrackingSink {
  recordPosted(
    connectionId: string,
    postId: string,
    discordMessageId: string,
  ): void;
}
