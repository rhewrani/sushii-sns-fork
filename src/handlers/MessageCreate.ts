import type { Message } from "discord.js";
import config from "../config/config";
import logger from "../logger";
import { extractLinksHandler } from "./links";
import { snsHandler } from "./sns";

const log = logger.child({ module: "MessageCreateHandler" });

export async function MessageCreateHandler(msg: Message): Promise<void> {
  if (msg.author.bot) {
    return;
  }

  if (!msg.inGuild()) {
    return;
  }

  if (!config.CHANNEL_ID_WHITELIST.includes(msg.channel.id)) {
    return;
  }

  log.debug({ msgID: msg.id }, "Received message in whitelisted channel");

  if (msg.content === "ping") {
    msg.reply("pong").catch((err) => log.error(err, "Failed to reply pong"));
  }

  await Promise.allSettled([extractLinksHandler(msg), snsHandler(msg)]);
}
