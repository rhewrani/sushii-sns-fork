import type { Database } from "bun:sqlite";
import type { PostTrackingSink } from "./postTracking";
import {
  checkIfPostWasPosted,
  getConnectionMeta,
  getPanelMessage,
  isPostSeen,
  markPostSeen,
  purgeAllConnectionMeta,
  purgeAllSeenPosts,
  purgeConnectionMeta,
  purgeConnectionSeenPosts,
  type LastFetch,
  type PanelMessage,
  type PostPostedCheck,
  upsertConnectionMeta,
  upsertPanelMessage,
  upsertPostedMessageTracking,
} from "./db";

export type { LastFetch, PanelMessage, PostPostedCheck };

/**
 * Monitor persistence: panel pointer, per-connection fetch meta, seen/post rows.
 * Implementations hide SQLite; callers do not use `Database` directly.
 */
export interface MonitorRepository extends PostTrackingSink {
  getPanelMessage(panelChannelId: string): PanelMessage | null;
  upsertPanelMessage(panelChannelId: string, messageId: string): void;
  getConnectionMeta(connectionId: string): LastFetch | null;
  upsertConnectionMeta(
    connectionId: string,
    lastFetchedAt: number,
    lastFetchedBy: string,
  ): void;
  isPostSeen(connectionId: string, postId: string): boolean;
  markPostSeen(connectionId: string, postId: string): void;
  purgeConnectionMeta(connectionId: string): void;
  purgeAllConnectionMeta(): void;
  purgeConnectionSeenPosts(connectionId: string): void;
  purgeAllSeenPosts(): void;
  checkIfPostWasPosted(connectionId: string, postId: string): PostPostedCheck;
}

export function createMonitorRepository(db: Database): MonitorRepository {
  return {
    recordPosted(connectionId: string, postId: string, discordMessageId: string): void {
      upsertPostedMessageTracking(db, connectionId, postId, discordMessageId);
    },
    getPanelMessage(panelChannelId: string) {
      return getPanelMessage(db, panelChannelId);
    },
    upsertPanelMessage(panelChannelId: string, messageId: string) {
      upsertPanelMessage(db, panelChannelId, messageId);
    },
    getConnectionMeta(connectionId: string) {
      return getConnectionMeta(db, connectionId);
    },
    upsertConnectionMeta(connectionId: string, lastFetchedAt: number, lastFetchedBy: string) {
      upsertConnectionMeta(db, connectionId, lastFetchedAt, lastFetchedBy);
    },
    isPostSeen(connectionId: string, postId: string) {
      return isPostSeen(db, connectionId, postId);
    },
    markPostSeen(connectionId: string, postId: string) {
      markPostSeen(db, connectionId, postId);
    },
    purgeConnectionMeta(connectionId: string) {
      purgeConnectionMeta(db, connectionId);
    },
    purgeAllConnectionMeta() {
      purgeAllConnectionMeta(db);
    },
    purgeConnectionSeenPosts(connectionId: string) {
      purgeConnectionSeenPosts(db, connectionId);
    },
    purgeAllSeenPosts() {
      purgeAllSeenPosts(db);
    },
    checkIfPostWasPosted(connectionId: string, postId: string) {
      return checkIfPostWasPosted(db, connectionId, postId);
    },
  };
}
