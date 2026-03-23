import type { Client, SendableChannels } from "discord.js";
import logger from "../../logger";
import type { MonitorsConfig } from "./config";

const log = logger.child({ module: "monitor/log-channel" });

export async function sendMonitorLog(
  client: Client,
  monitorsConfig: MonitorsConfig,
  message: string,
): Promise<void> {
  const channelId = monitorsConfig.log_channel_id;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await (channel as SendableChannels).send({ content: message });
  } catch (err) {
    log.warn({ err, channelId }, "Failed to send monitor log message");
  }
}
