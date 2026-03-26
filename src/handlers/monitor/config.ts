import { readFileSync } from "fs";
import { z } from "zod";
import { writeFileSync } from "fs";

export const ConnectionTypeSchema = z.enum(["instagram", "tiktok", "twitter"]);

export const ConnectionSchema = z.object({
  type: ConnectionTypeSchema,
  handle: z.string().min(1),
  igId: z.string().min(1).optional(),
  cooldown_seconds: z.number().int().nonnegative(),
});

export const MonitorsConfigSchema = z.object({
  // Where the single pinned panel embed lives.
  panel_channel_id: z.string().min(1),

  // Where “final” media posts go after review.
  socials_channel_id: z.string().min(1),

  // Role required to click poll buttons (null => allow everyone).
  trigger_role_id: z.string().min(1).nullable(),
  // Optional channel for monitor system logs.
  log_channel_id: z.string().min(1).nullable().optional(),

  // Shared formatting for all connection types.
  format: z.enum(["links", "inline"]),
  template: z.string().min(1),

  // Connections that appear as buttons on the panel.
  connections: z.array(ConnectionSchema),
});

export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type MonitorsConfig = z.infer<typeof MonitorsConfigSchema>;

export function getConnectionId(connection: Pick<Connection, "type" | "handle">): string {
  // Deterministic internal ID used in button customIds and DB.
  return `${connection.type}:${connection.handle}`;
}

export function loadMonitorsConfig(path: string): MonitorsConfig {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return MonitorsConfigSchema.parse(json);
}

/**
 * Save monitors config to disk.
 */
export function saveMonitorsConfig(path: string, config: MonitorsConfig): void {
  const validated = MonitorsConfigSchema.parse(config);
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf-8");
}

export function findConnectionById(config: MonitorsConfig, connectionId: string): Connection | null {
  const [type, handle] = connectionId.split(":");
  if (!type || !handle) return null;
  return config.connections.find((c) => c.type === type && c.handle === handle) ?? null;
}
