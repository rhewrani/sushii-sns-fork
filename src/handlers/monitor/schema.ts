// Each entry is an array of SQL statements for that migration version.
// On startup, runMigrations applies pending migrations in order and updates PRAGMA user_version.
export const MIGRATIONS: string[][] = [
  // Migration 0 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS monitor_messages (
      ig_username TEXT NOT NULL,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      PRIMARY KEY (ig_username, channel_id)
    )`,

    `CREATE TABLE IF NOT EXISTS monitor_fetches (
      ig_username     TEXT    NOT NULL PRIMARY KEY,
      last_fetched_at INTEGER NOT NULL,
      last_fetched_by TEXT    NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS monitor_seen_posts (
      ig_username TEXT    NOT NULL,
      post_id     TEXT    NOT NULL,
      seen_at     INTEGER NOT NULL,
      PRIMARY KEY (ig_username, post_id)
    )`,
  ],
];
