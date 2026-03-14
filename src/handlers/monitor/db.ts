import { Database } from "bun:sqlite";
import logger from "../../logger";
import { MIGRATIONS } from "./schema";

const log = logger.child({ module: "monitor/db" });

export type MonitorMessage = {
  ig_username: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
};

export type LastFetch = {
  ig_username: string;
  last_fetched_at: number;
  last_fetched_by: string;
};

function runMigrations(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = row.user_version;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    log.info({ version: i }, "Running DB migration");
    for (const sql of MIGRATIONS[i]) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL;");

  runMigrations(db);

  return db;
}

export function getLastFetch(
  db: Database,
  igUsername: string,
): LastFetch | null {
  const row = db
    .query<LastFetch, [string]>(
      "SELECT ig_username, last_fetched_at, last_fetched_by FROM monitor_fetches WHERE ig_username = ?",
    )
    .get(igUsername);
  return row ?? null;
}

export function upsertLastFetch(
  db: Database,
  igUsername: string,
  lastFetchedAt: number,
  lastFetchedBy: string,
): void {
  db.query(
    "INSERT INTO monitor_fetches (ig_username, last_fetched_at, last_fetched_by) VALUES (?, ?, ?) ON CONFLICT(ig_username) DO UPDATE SET last_fetched_at = excluded.last_fetched_at, last_fetched_by = excluded.last_fetched_by",
  ).run(igUsername, lastFetchedAt, lastFetchedBy);
}

export function isPostSeen(
  db: Database,
  igUsername: string,
  postId: string,
): boolean {
  const row = db
    .query<{ count: number }, [string, string]>(
      "SELECT COUNT(*) as count FROM monitor_seen_posts WHERE ig_username = ? AND post_id = ?",
    )
    .get(igUsername, postId);
  return (row?.count ?? 0) > 0;
}

export function markPostSeen(
  db: Database,
  igUsername: string,
  postId: string,
): void {
  db.query(
    "INSERT OR IGNORE INTO monitor_seen_posts (ig_username, post_id, seen_at) VALUES (?, ?, ?)",
  ).run(igUsername, postId, Date.now());
}

export function getMonitorMessage(
  db: Database,
  igUsername: string,
  channelId: string,
): MonitorMessage | null {
  const row = db
    .query<MonitorMessage, [string, string]>(
      "SELECT ig_username, guild_id, channel_id, message_id FROM monitor_messages WHERE ig_username = ? AND channel_id = ?",
    )
    .get(igUsername, channelId);
  return row ?? null;
}

export function upsertMonitorMessage(
  db: Database,
  igUsername: string,
  guildId: string,
  channelId: string,
  messageId: string,
): void {
  db.query(
    "INSERT INTO monitor_messages (ig_username, guild_id, channel_id, message_id) VALUES (?, ?, ?, ?) ON CONFLICT(ig_username, channel_id) DO UPDATE SET message_id = excluded.message_id, guild_id = excluded.guild_id",
  ).run(igUsername, guildId, channelId, messageId);
}
