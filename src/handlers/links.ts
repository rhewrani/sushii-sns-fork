import type { Message } from "discord.js";
import { MessageFlags } from "discord.js";
import logger from "../logger";
import { itemsToMessageContents } from "../utils/discord";

const log = logger.child({ module: "extractLinksHandler" });

export async function extractLinksHandler(msg: Message<true>): Promise<void> {
  if (!msg.channel.isSendable()) {
    return;
  }

  if (!msg.reference) {
    return;
  }

  if (msg.content.trim() !== "links") {
    return;
  }

  const refMsg = await msg.fetchReference();
  log.debug(
    {
      requester: msg.author.username,
      refMsgID: refMsg.id,
      refMsgAttachments: refMsg.attachments.size,
    },
    "Extracting links from message",
  );

  if (refMsg.attachments.size === 0) {
    // Check if the message includes image is a links
    if (refMsg.content.includes("https://")) {
      await msg.reply({
        content: refMsg.content,
        flags: MessageFlags.SuppressEmbeds,
      });

      return;
    }

    await msg.reply("No attachments found in replied to message noob");
    return;
  }

  // Group attachments into list of strings max 2000 characters
  const msgs = itemsToMessageContents(
    "",
    refMsg.attachments.map((a) => a.url),
  );

  log.debug(
    {
      requester: msg.author.username,
      refMsgID: refMsg.id,
      attachments: refMsg.attachments.size,
      numMsgs: msgs.length,
    },
    "Found attachment links, sending",
  );

  try {
    if (msgs.length > 1) {
      await msg.reply(
        "Links in __multiple messages__ below, make sure to copy all of them",
      );
    }

    for (const msgContent of msgs) {
      await msg.reply({
        content: msgContent,
        flags: MessageFlags.SuppressEmbeds,
      });
    }
  } catch (err) {
    log.error(err, "Failed to send links");

    await msg.reply("oops couldnt get links, <@150443906511667200> fix me pls");
  }
}

// Simple fallback parser — add to utils or inline
export function parseUsernameFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    
    // https://www.tiktok.com/@USERNAME/video/123
    const match = urlObj.pathname.match(/^\/@([^\/\?#]+)/);
    return match?.[1];
  } catch {
    // URL parsing failed
  }
  return undefined;
}