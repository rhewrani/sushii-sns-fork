import { type Attachment, type Message } from "discord.js";
import logger from "../logger";
import {
  SnsDownloader,
  type AnySnsMetadata,
  type PostData,
  type ProgressFn,
  type SnsLink,
  type SnsMetadata,
} from "../platforms/base";
import { InstagramPostDownloader } from "../platforms/instagram-post/downloader";
import { InstagramStoryDownloader } from "../platforms/instagram-story/downloader";
import { TikTokDownloader } from "../platforms/tiktok/downloader";
import { TwitterDownloader } from "../platforms/twitter/downloader";

const log = logger.child({ module: "snsHandler" });

const downloaders = [
  new TwitterDownloader(),
  new InstagramPostDownloader(),
  new InstagramStoryDownloader(),
  new TikTokDownloader(),
];

export function findAllSnsLinks(content: string): SnsLink<AnySnsMetadata>[] {
  let snsLinks: SnsLink<AnySnsMetadata>[] = [];
  for (const downloader of downloaders) {
    const urls = downloader.findUrls(content);
    snsLinks = snsLinks.concat(urls);
  }

  return snsLinks;
}

export function getPlatform<M extends SnsMetadata>(
  metadata: M,
): SnsDownloader<AnySnsMetadata> {
  const downloader = downloaders.find(
    (downloader) => downloader.PLATFORM === metadata.platform,
  );
  if (!downloader) {
    throw new Error(`Unsupported platform: ${metadata.platform}`);
  }

  return downloader;
}


export async function* snsService(
  snsLinks: SnsLink<AnySnsMetadata>[],
  processFn?: ProgressFn,
): AsyncGenerator<PostData<AnySnsMetadata>[]> {
  for (const snsLink of snsLinks) {
    const platform = getPlatform(snsLink.metadata);

    const content = await platform.fetchContent(snsLink, processFn);

    // Generator yields the message
    yield content;
  }
}

export async function snsHandler(msg: Message<true>): Promise<void> {
  if (!msg.channel.isSendable()) {
    return;
  }

  if (!msg.content.startsWith("dl")) {
    return;
  }

  log.debug(
    { requester: msg.author.username, content: msg.content },
    "Processing sns message",
  );

  const posts = findAllSnsLinks(msg.content);

  if (posts.length === 0) {
    log.debug(
      { requester: msg.author.username, content: msg.content },
      "No sns posts found",
    );

    return;
  }

  const reaction_emojis = [
    "👍",
    "<:aLISA_star:1367498109801861211>",
  ];

  const reaction =
    reaction_emojis[Math.floor(Math.random() * reaction_emojis.length)];

  // Only if there are posts to process
  // Don't wait for acks
  Promise.all([
    msg.suppressEmbeds(true),
    msg.react(reaction),
    msg.channel.sendTyping(),
  ]).catch((err) => logger.error(err, "failed to suppress/react/type"));

  let progressMsg: Message | null = null;
  let progressPromise = Promise.resolve();

  const progressUpdater = async (content: string, done?: boolean) => {
    // Create a new function that captures the current operation
    const updateOperation = async () => {
      try {
        // Delete when done
        if (done && progressMsg) {
          await progressMsg.delete();
          progressMsg = null;
          return;
        }

        // Edit if exists
        if (progressMsg) {
          await progressMsg.edit(content);
          return;
        }

        // Send if not exists
        progressMsg = await msg.channel.send({
          content: content,
        });
      } catch (err) {
        logger.error(err, "failed to send sns progress update message");
      }
    };

    // Wait for previous operations to complete, then run this one
    progressPromise = progressPromise.then(updateOperation);
    return progressPromise;
  };

  try {
    for await (const postDatas of snsService(posts, progressUpdater)) {
      for (const postData of postDatas) {
        const platform = getPlatform(postData.postLink.metadata);

        // 1. Send images first
        // 2. Get the links to images
        // 3. Send the message with the links
        const fileMsgs = platform.buildDiscordAttachments(postData);

        const attachments: Attachment[] = [];

        for (const fileMsg of fileMsgs) {
          const filesMsg = await msg.channel.send(fileMsg);
          attachments.push(...filesMsg.attachments.values());
        }

        const links = attachments.map((attachment) => attachment.url);
        const msgs = platform.buildDiscordMessages(postData, links);

        for (const postMsg of msgs) {
          await msg.reply({
            ...postMsg,
            allowedMentions: { parse: [] },
          });
        }
      }
    }
  } catch (err) {
    logger.error(err, "failed to process sns message");
    let errMsg = "oops borked the download, pls try again!!";
    errMsg += `\n\nError: ${err}\n`;

    await msg.channel.send(errMsg);
  }
}
