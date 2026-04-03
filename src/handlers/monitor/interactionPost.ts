import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { isConnectionMonitored, type ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { AnySnsMetadata, SnsLink } from "../../platforms/base";
import { MediaTooLargeError, sendPostToChannel } from "../../utils/discord";
import { parseUsernameFromUrl } from "../../utils/socialUrls";
import type { MonitorsConfig } from "./config";
import { checkIfPostWasPosted } from "./db";
import { findAllSnsLinks, snsService } from "../sns";

const log = logger.child({ module: "monitor/interactionPost" });

export type ConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; reason: "skipped" | "timeout" | "error" };

// ---------------------------------------------------------------------------
// /post command + duplicate confirmation
// ---------------------------------------------------------------------------

export async function promptRepostConfirmation(
  interaction: ChatInputCommandInteraction,
  socialsChannelId: string,
  existingMessageId: string | null,
): Promise<ConfirmationResult> {
  const existingPostLink = existingMessageId && interaction.guildId
    ? `\nhttps://discord.com/channels/${interaction.guildId}/${socialsChannelId}/${existingMessageId}`
    : "";

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("post_confirm_yes")
      .setLabel("✅ Post Anyway")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("post_confirm_no")
      .setLabel("❌ Skip")
      .setStyle(ButtonStyle.Danger),
  );

  const confirmMsg = await interaction.followUp({
    content: `⚠️ This post was already sent to the socials channel.${existingPostLink}\n\nDo you want to post it again?`,
    components: [confirmRow],
    flags: MessageFlags.Ephemeral,
  });

  try {
    const confirmation = await confirmMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 30_000,
    });

    if (confirmation.customId === "post_confirm_no") {
      await confirmMsg.edit({
        content: "⏭️ Skipped.",
        components: [],
      });
      return { confirmed: false, reason: "skipped" };
    }

    await confirmMsg.edit({
      content: "🔄 Posting again...",
      components: [],
    });
    return { confirmed: true };
  } catch {
    await confirmMsg.edit({
      content: "⏰ Confirmation timed out — skipping post.",
      components: [],
    }).catch(() => {});

    return { confirmed: false, reason: "timeout" };
  }
}

function extractConnectionInfo(link: SnsLink<AnySnsMetadata>): {
  username?: string;
  postId?: string;
  canCheckBeforeFetch: boolean;
} {
  const { metadata, url } = link;

  switch (metadata.platform) {
    case "twitter":
      return {
        username: metadata.username,
        postId: metadata.id,
        canCheckBeforeFetch: true,
      };

    case "tiktok":
      return {
        username: parseUsernameFromUrl(url),
        postId: metadata.videoId,
        canCheckBeforeFetch: true,
      };

    case "instagram":
    case "instagram-story":
      return {
        username: metadata.username,
        postId: metadata.shortcode,
        canCheckBeforeFetch: false,
      };

    default:
      return { username: undefined, postId: undefined, canCheckBeforeFetch: false };
  }
}

async function checkDuplicateBeforeFetch(
  metadataDb: Database,
  connectionId: string,
  postId: string,
  monitorsConfig: MonitorsConfig,
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!isConnectionMonitored(monitorsConfig, connectionId)) return true;

  const check = checkIfPostWasPosted(metadataDb, connectionId, postId);

  if (check.wasPosted) {
    const result = await promptRepostConfirmation(
      interaction,
      monitorsConfig.socials_channel_id,
      check.messageId,
    );
    return result.confirmed;
  }
  return true;
}

export async function handlePostCommand(
  interaction: ChatInputCommandInteraction,
  monitorsConfig: MonitorsConfig,
  _serverConfig: ServerConfig | null,
  client: Client,
  _db: Database,
): Promise<void> {
  await interaction.deferReply();

  const postUrl = interaction.options.getString("url", true);
  log.debug({ requester: interaction.user.username, url: postUrl }, "Processing /post");

  const posts = findAllSnsLinks(postUrl);
  if (posts.length === 0) {
    await interaction.editReply("❌ No valid social media links found.");
    return;
  }

  const socialsChannel = await client.channels.fetch(monitorsConfig.socials_channel_id);
  if (!socialsChannel || !("send" in socialsChannel)) {
    await interaction.editReply("❌ Could not find the socials channel.");
    return;
  }

  try {
    const link = posts[0];
    const platform = link.metadata.platform;
    const normalizedPlatform = platform.replace(/-story$/, "");

    let finalConnectionId: string | undefined;
    let connectionExists = false;

    const { username, postId, canCheckBeforeFetch } = extractConnectionInfo(link);

    if (canCheckBeforeFetch && username && postId) {
      finalConnectionId = `${normalizedPlatform}:${username}`;

      const confirmed = await checkDuplicateBeforeFetch(
        _db,
        finalConnectionId,
        postId,
        monitorsConfig,
        interaction,
      );
      if (!confirmed) return;
    }

    const postData = (await snsService(posts, async () => {}).next()).value?.[0];
    if (!postData || !postData.postID) {
      await interaction.editReply("❌ Could not fetch post content.");
      return;
    }

    // ideally: check if post already exists in db by using the platform + username + post id (e.g. instagram:username and check for post id)
    // BEFORE fetching, to save bandwith if user decides to skip
    // problem with instagram POSTS: with format https://www.instagram.com/p/SHORTCODE/ we don't have the username and we cant check db
    // so we check AFTER sns downloader fetched all the data (I know not optimal)
    if ((platform === "instagram" || platform === "instagram-story") && postData.username) {
      finalConnectionId = `${normalizedPlatform}:${postData.username}`;

      if (isConnectionMonitored(monitorsConfig, finalConnectionId)) {
        connectionExists = true;

        const confirmed = await checkDuplicateBeforeFetch(
          _db,
          finalConnectionId,
          postData.postID,
          monitorsConfig,
          interaction,
        );
        if (!confirmed) return;
      }
    }

    const result = await sendPostToChannel(socialsChannel as SendableChannels, postData, {
      format: monitorsConfig.format,
      template: monitorsConfig.template,
      metadataDb: connectionExists ? _db : undefined,
      connectionId: connectionExists ? finalConnectionId : undefined,
      postId: connectionExists ? postData.postID : undefined,
    });

    const jumpLink = result.messageIds[0]
      ? `\nhttps://discord.com/channels/${interaction.guildId}/${socialsChannel.id}/${result.messageIds[0]}`
      : "";

    await interaction.editReply(`✅ Post sent to socials channel!${jumpLink}`);
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      await interaction.editReply(
        `❌ Media file is too large to upload (${(err.size / 1024 / 1024).toFixed(1)}MB). Discord's limit is 8MB.\n` +
          `View the post directly: ${postUrl}`,
      );
      return;
    }

    const { requestBody: _body, ...safeErr } = (err as any) ?? {};
    log.error(safeErr, "/post command failed");
    await interaction.followUp({
      content: `❌ Error: ${String(err)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
