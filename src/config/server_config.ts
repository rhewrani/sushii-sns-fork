import { readFileSync } from "fs";
import { z } from "zod";

export const GuildConfigSchema = z.object({
  guild_id: z.string(),
  template: z.string().optional(),
});

export const ServerConfigSchema = z.object({
  guilds: z.array(GuildConfigSchema),
});

export type GuildConfig = z.infer<typeof GuildConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadServerConfig(path: string): ServerConfig {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return ServerConfigSchema.parse(json);
}

export function getGuildTemplate(
  config: ServerConfig | null,
  guildId: string,
): string | undefined {
  if (!config) {
    return undefined;
  }

  const guild = config.guilds.find((g) => g.guild_id === guildId);
  return guild?.template;
}

/**
 * Check if a connection is configured in monitorsConfig.
 */
export function isConnectionMonitored(
  monitorsConfig: { connections: Array<{ type: string; handle: string }> },
  connectionId: string,
): boolean {
  return monitorsConfig.connections.some((c) => {
    const configPlatform = c.type.replace(/-story$/, "");
    return `${configPlatform}:${c.handle}` === connectionId;
  });
}
