// Each entry is an array of SQL statements for that migration version.
// On startup, runMigrations applies pending migrations in order and updates PRAGMA user_version.

export const METADATA_MIGRATIONS: string[][] = [
  // Migration 0 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS monitor_panel_messages (
      panel_channel_id TEXT NOT NULL PRIMARY KEY,
      message_id TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS monitor_connection_meta (
      connection_id TEXT NOT NULL PRIMARY KEY,
      last_fetched_at INTEGER NOT NULL,
      last_fetched_by TEXT NOT NULL
    )`,
  ],
];

export const CONNECTION_MIGRATIONS: string[][] = [
  // Migration 0 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS seen_posts (
      post_id TEXT NOT NULL PRIMARY KEY,
      seen_at INTEGER NOT NULL
    )`,
  ],
];
