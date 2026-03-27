import { Database } from "bun:sqlite";
import { dirname, join } from "path";
import logger from "../../logger";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { CONNECTION_MIGRATIONS, METADATA_MIGRATIONS } from "./schema";

const log = logger.child({ module: "monitor/db" });

let metadataDbPathForConnections: string | null = null;

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
  metadataDbPathForConnections = path;
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL;");
  runMigrations(db, METADATA_MIGRATIONS);
  // Safety: if the DB was created with an older monitor schema, PRAGMA user_version
  // may prevent our migrations from running. Ensure the new tables exist anyway.
  for (const migration of METADATA_MIGRATIONS) {
    for (const sql of migration) db.exec(sql);
  }

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

function sanitizeConnectionIdForFile(connectionId: string): string {
  // Encode then replace `%` to avoid odd edge-cases on Windows paths.
  return encodeURIComponent(connectionId).replace(/%/g, "_");
}

function getConnectionDbPath(metadataDbPath: string, connectionId: string): string {
  const baseDir = dirname(metadataDbPath);
  const connectionsDir = getConnectionsDbDir(baseDir);
  const fileName = `${sanitizeConnectionIdForFile(connectionId)}.db`;
  return join(connectionsDir, fileName);
}

function getConnectionsDbDir(baseDir: string): string {
  return join(baseDir, "connections-db");
}

function openConnectionDb(connectionDbPath: string): Database {
  const db = new Database(connectionDbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  runMigrations(db, CONNECTION_MIGRATIONS);
  // Safety: same as metadata DB — ensure the required tables exist.
  // for (const migration of CONNECTION_MIGRATIONS) {
  //   for (const sql of migration) db.exec(sql);
  // }
  return db;
}

const connectionDbCache = new Map<string, Database>();

export function getConnectionDb(
  connectionId: string,
): Database {
  if (!metadataDbPathForConnections) {
    throw new Error("openMetadataDb() must be called before getConnectionDb()");
  }

  const connectionDbPath = getConnectionDbPath(metadataDbPathForConnections, connectionId);
  const cached = connectionDbCache.get(connectionDbPath);
  if (cached) return cached;

  // Ensure folder exists before sqlite opens/creates.
  mkdirSync(dirname(connectionDbPath), { recursive: true });
  const db = openConnectionDb(connectionDbPath);
  connectionDbCache.set(connectionDbPath, db);
  return db;
}

export function isPostSeen(connectionDb: Database, postId: string): boolean {
  const row = connectionDb
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM seen_posts WHERE post_id = ?",
    )
    .get(postId);
  return (row?.count ?? 0) > 0;
}

export function markPostSeen(connectionDb: Database, postId: string): void {
  connectionDb
    .query(
      "INSERT OR IGNORE INTO seen_posts (post_id, seen_at) VALUES (?, ?)",
    )
    .run(postId, Date.now());
}

export function purgeConnectionMeta(db: Database, connectionId: string): void {
  db.query("DELETE FROM monitor_connection_meta WHERE connection_id = ?").run(connectionId);
}

export function purgeAllConnectionMeta(db: Database): void {
  db.exec("DELETE FROM monitor_connection_meta");
}

export function purgeConnectionSeenPosts(connectionId: string): void {
  const connectionDb = getConnectionDb(connectionId);
  connectionDb.exec("DELETE FROM seen_posts");
}

export function purgeAllSeenPosts(): void {
  if (!metadataDbPathForConnections) {
    throw new Error("openMetadataDb() must be called before purgeAllSeenPosts()");
  }

  const baseDir = dirname(metadataDbPathForConnections);
  const connectionsDir = getConnectionsDbDir(baseDir);
  if (!existsSync(connectionsDir)) return;

  // Purge already-open DB handles.
  for (const db of connectionDbCache.values()) {
    db.exec("DELETE FROM seen_posts");
  }

  // Purge all .db files in the directory (including ones not yet opened in cache).
  const fileNames = readdirSync(connectionsDir);
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".db")) continue;
    const path = join(connectionsDir, fileName);
    const db = new Database(path, { create: true });
    db.exec("DELETE FROM seen_posts");
    db.close();
  }
}

// === Posted Message ID Tracking ===

/**
 * Get the Discord message ID for a post that was sent to the socials channel.
 * Returns null if the post was seen but never posted (e.g., rejected in review).
 */
export function getPostedMessageId(
  connectionDb: Database,
  postId: string,
): string | null {
  const row = connectionDb
    .query<{ posted_message_id: string | null }, [string]>(
      "SELECT posted_message_id FROM seen_posts WHERE post_id = ?",
    )
    .get(postId);
  return row?.posted_message_id ?? null;
}

/**
 * Record that a post was successfully sent to the socials channel.
 * Upserts the posted_message_id for the given post_id.
 */
export function markPostPosted(
  connectionDb: Database,
  postId: string,
  messageId: string,
): void {
  // First ensure the post is marked as seen (in case it wasn't)
  connectionDb
    .query(
      "INSERT OR IGNORE INTO seen_posts (post_id, seen_at) VALUES (?, ?)",
    )
    .run(postId, Date.now());
  
  // Then update the posted_message_id
  connectionDb
    .query(
      "UPDATE seen_posts SET posted_message_id = ? WHERE post_id = ?",
    )
    .run(messageId, postId);
}

/**
 * Clear the posted_message_id for a post (e.g., if the message was deleted).
 * Does NOT unmark the post as seen.
 */
export function clearPostedMessageId(
  connectionDb: Database,
  postId: string,
): void {
  connectionDb
    .query(
      "UPDATE seen_posts SET posted_message_id = NULL WHERE post_id = ?",
    )
    .run(postId);
}

/**
 * Get all posts for a connection that have been posted (have a message ID).
 * Useful for cleanup or audit operations.
 */
export function getPostedPosts(
  connectionDb: Database,
): Array<{ post_id: string; posted_message_id: string; seen_at: number }> {
  return connectionDb
    .query<
      { post_id: string; posted_message_id: string; seen_at: number },
      []
    >(
      "SELECT post_id, posted_message_id, seen_at FROM seen_posts WHERE posted_message_id IS NOT NULL",
    )
    .all();
}

/**
 * Check if a post was already posted to the socials channel.
 * Returns both the status and the existing message ID (if any).
 */
export function checkIfPostWasPosted(
  connectionDb: Database,
  postId: string,
): PostPostedCheck {
  const row = connectionDb
    .query<{ posted_message_id: string | null }, [string]>(
      "SELECT posted_message_id FROM seen_posts WHERE post_id = ?",
    )
    .get(postId);
  
  const messageId = row?.posted_message_id ?? null;
  const wasPosted = messageId !== null;
  
  if (messageId !== null) {
    return { wasPosted: true as const, messageId };
  } else {
    return { wasPosted: false as const, messageId: null };
  }
}