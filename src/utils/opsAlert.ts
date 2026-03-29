import type { SendableChannels } from "discord.js";
import config from "../config/config";

const DEFAULT_ALERT_USER_ID = "415912994698952706";

function resolveAlertUserId(): string | null {
  const raw = config.ALERT_DISCORD_USER_ID;
  if (raw !== undefined && raw.trim() === "") {
    return null;
  }
  const id = (raw?.trim() || DEFAULT_ALERT_USER_ID);
  return id.length > 0 ? id : null;
}

/**
 * Public channel message for serious failures (not ephemeral). Mentions ops when configured.
 */
export async function sendOpsAlert(
  channel: SendableChannels,
  heading: string,
  err: unknown,
  extraLines?: string,
): Promise<void> {
  const userId = resolveAlertUserId();
  const mention = userId ? `<@${userId}> ` : "";
  const detail =
    err instanceof Error
      ? err.stack ?? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err, null, 2);

  const clipped = detail.length > 1600 ? `${detail.slice(0, 1600)}…` : detail;
  let content = `${mention}**${heading}**\n\`\`\`${clipped}\`\`\``;
  if (extraLines?.trim()) {
    content += `\n${extraLines.trim()}`;
  }

  await channel.send({
    content,
    allowedMentions: userId
      ? { users: [userId], parse: [] }
      : { parse: [] },
  });
}
