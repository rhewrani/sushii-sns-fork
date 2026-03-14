import { readFileSync } from "fs";
import { z } from "zod";

export const WatcherSchema = z.object({
  guild_id: z.string(),
  channel_id: z.string(),
  format: z.enum(["links", "inline"]),
  allowed_role_id: z.string().nullable(),
  template: z.string().optional(),
});

export const SubscriptionSchema = z.object({
  ig_username: z.string(),
  fetch_cooldown_seconds: z.number(),
  watchers: z.array(WatcherSchema),
});

export const MonitorsConfigSchema = z.object({
  subscriptions: z.array(SubscriptionSchema),
});

export type Watcher = z.infer<typeof WatcherSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type MonitorsConfig = z.infer<typeof MonitorsConfigSchema>;

export function loadMonitorsConfig(path: string): MonitorsConfig {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return MonitorsConfigSchema.parse(json);
}

/**
 * Find the subscription for a given channel ID across all subscriptions.
 * Returns [subscription, watcher] or null if not found.
 */
export function findSubscriptionByChannel(
  config: MonitorsConfig,
  channelId: string,
): [Subscription, Watcher] | null {
  for (const sub of config.subscriptions) {
    const watcher = sub.watchers.find((w) => w.channel_id === channelId);
    if (watcher) {
      return [sub, watcher];
    }
  }
  return null;
}

/**
 * Find the subscription for a given ig_username.
 */
export function findSubscriptionByUsername(
  config: MonitorsConfig,
  igUsername: string,
): Subscription | null {
  return config.subscriptions.find((s) => s.ig_username === igUsername) ?? null;
}
