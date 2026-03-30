import type { SendableChannels } from "discord.js";
import config from "../config/config";

const DEFAULT_ALERT_USER_ID = "150443906511667200";

/** Discord user ID for ops mentions (from `ALERT_DISCORD_USER_ID` or default). Empty env disables. */
export function getOpsAlertUserId(): string | null {
  const raw = config.ALERT_DISCORD_USER_ID;
  if (raw !== undefined && raw.trim() === "") {
    return null;
  }
  const id = raw?.trim() || DEFAULT_ALERT_USER_ID;
  return id.length > 0 ? id : null;
}

/** User-facing line when the `links` command fails to send. Uses same ops ID as `sendOpsAlert`. */
export function formatLinksFailureReply(): string {
  const userId = getOpsAlertUserId();
  if (userId) {
    return `oops couldnt get links, <@${userId}> fix me pls`;
  }
  return "oops couldnt get links, fix me pls";
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
  const userId = getOpsAlertUserId();
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
