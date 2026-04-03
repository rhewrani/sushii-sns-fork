import { Database } from "bun:sqlite";
import logger from "../../logger";
import { METADATA_MIGRATIONS } from "./schema";

const log = logger.child({ module: "monitor/db" });

export type LastFetch = {
  last_fetched_at: number;
  last_fetched_by: string;
};

export type PanelMessage = {
  panel_channel_id: string;
  message_id: string;
};

export type ConnectionMeta = {
  connection_id: string;
  last_fetched_at: number;
  last_fetched_by: string;
};

export type PostPostedCheck =
  | { wasPosted: false; messageId: null }
  | { wasPosted: true; messageId: string };

function runMigrations(db: Database, migrations: string[][]): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = row.user_version;

  for (let i = currentVersion; i < migrations.length; i++) {
    log.info({ version: i }, "Running DB migration");
    for (const sql of migrations[i]) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
}

export function openMetadataDb(path: string): Database {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL;");
  runMigrations(db, METADATA_MIGRATIONS);

  return db;
}

export function getPanelMessage(
  db: Database,
  panelChannelId: string,
): PanelMessage | null {
  const row = db
    .query<PanelMessage, [string]>(
      "SELECT panel_channel_id, message_id FROM monitor_panel_messages WHERE panel_channel_id = ?",
    )
    .get(panelChannelId);
  return row ?? null;
}

export function upsertPanelMessage(
  db: Database,
  panelChannelId: string,
  messageId: string,
): void {
  db.query(
    "INSERT INTO monitor_panel_messages (panel_channel_id, message_id) VALUES (?, ?) ON CONFLICT(panel_channel_id) DO UPDATE SET message_id = excluded.message_id",
  ).run(panelChannelId, messageId);
}

export function getConnectionMeta(
  db: Database,
  connectionId: string,
): LastFetch | null {
  const row = db
    .query<ConnectionMeta, [string]>(
      "SELECT connection_id, last_fetched_at, last_fetched_by FROM monitor_connection_meta WHERE connection_id = ?",
    )
    .get(connectionId);
  return row
    ? {
        last_fetched_at: row.last_fetched_at,
        last_fetched_by: row.last_fetched_by,
      }
    : null;
}

export function upsertConnectionMeta(
  db: Database,
  connectionId: string,
  lastFetchedAt: number,
  lastFetchedBy: string,
): void {
  db.query(
    "INSERT INTO monitor_connection_meta (connection_id, last_fetched_at, last_fetched_by) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET last_fetched_at = excluded.last_fetched_at, last_fetched_by = excluded.last_fetched_by",
  ).run(connectionId, lastFetchedAt, lastFetchedBy);
}

export function isPostSeen(
  db: Database,
  connectionId: string,
  postId: string,
): boolean {
  const row = db
    .query<{ count: number }, [string, string]>(
      "SELECT COUNT(*) as count FROM monitor_seen_posts WHERE connection_id = ? AND post_id = ?",
    )
    .get(connectionId, postId);
  return (row?.count ?? 0) > 0;
}

export function markPostSeen(
  db: Database,
  connectionId: string,
  postId: string,
): void {
  db.query(
    "INSERT OR IGNORE INTO monitor_seen_posts (connection_id, post_id, seen_at) VALUES (?, ?, ?)",
  ).run(connectionId, postId, Date.now());
}

export function purgeConnectionMeta(db: Database, connectionId: string): void {
  db.query("DELETE FROM monitor_connection_meta WHERE connection_id = ?").run(connectionId);
}

export function purgeAllConnectionMeta(db: Database): void {
  db.exec("DELETE FROM monitor_connection_meta");
}

export function purgeConnectionSeenPosts(db: Database, connectionId: string): void {
  db.query("DELETE FROM monitor_seen_posts WHERE connection_id = ?").run(connectionId);
}

export function purgeAllSeenPosts(db: Database): void {
  db.exec("DELETE FROM monitor_seen_posts");
}

// === Posted Message ID Tracking ===

function queryPostedMessageId(
  db: Database,
  connectionId: string,
  postId: string,
): string | null {
  const row = db
    .query<{ posted_message_id: string | null }, [string, string]>(
      "SELECT posted_message_id FROM monitor_seen_posts WHERE connection_id = ? AND post_id = ?",
    )
    .get(connectionId, postId);
  return row?.posted_message_id ?? null;
}

/**
 * Get the Discord message ID for a post that was sent to the socials channel.
 * Returns null if the post was seen but never posted (e.g., rejected in review).
 */
export function getPostedMessageId(
  db: Database,
  connectionId: string,
  postId: string,
): string | null {
  return queryPostedMessageId(db, connectionId, postId);
}

/**
 * Record that a post was successfully sent to the socials channel.
 * Upserts the posted_message_id for the given post_id.
 */
export function markPostPosted(
  db: Database,
  connectionId: string,
  postId: string,
  messageId: string,
): void {
  db.query(
    "INSERT OR IGNORE INTO monitor_seen_posts (connection_id, post_id, seen_at) VALUES (?, ?, ?)",
  ).run(connectionId, postId, Date.now());

  db.query(
    "UPDATE monitor_seen_posts SET posted_message_id = ? WHERE connection_id = ? AND post_id = ?",
  ).run(messageId, connectionId, postId);
}

/**
 * Clear the posted_message_id for a post (e.g., if the message was deleted).
 * Does NOT unmark the post as seen.
 */
export function clearPostedMessageId(
  db: Database,
  connectionId: string,
  postId: string,
): void {
  db.query(
    "UPDATE monitor_seen_posts SET posted_message_id = NULL WHERE connection_id = ? AND post_id = ?",
  ).run(connectionId, postId);
}

/**
 * Get all posts for a connection that have been posted (have a message ID).
 * Useful for cleanup or audit operations.
 */
export function getPostedPosts(
  db: Database,
  connectionId: string,
): Array<{ post_id: string; posted_message_id: string; seen_at: number }> {
  return db
    .query<
      { post_id: string; posted_message_id: string; seen_at: number },
      [string]
    >(
      "SELECT post_id, posted_message_id, seen_at FROM monitor_seen_posts WHERE connection_id = ? AND posted_message_id IS NOT NULL",
    )
    .all(connectionId);
}

/**
 * Check if a post was already posted to the socials channel.
 * Returns both the status and the existing message ID (if any).
 */
export function checkIfPostWasPosted(
  db: Database,
  connectionId: string,
  postId: string,
): PostPostedCheck {
  const messageId = queryPostedMessageId(db, connectionId, postId);
  if (messageId !== null) {
    return { wasPosted: true as const, messageId };
  }
  return { wasPosted: false as const, messageId: null };
}
