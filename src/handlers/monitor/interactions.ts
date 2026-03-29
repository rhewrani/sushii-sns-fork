import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type MessageEditOptions,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { isConnectionMonitored, type ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import { MediaTooLargeError, sendPostToChannel } from "../../utils/discord";
import type { MonitorsConfig } from "./config";
import {
  findConnectionById,
  getConnectionId,
} from "./config";
import {
  checkIfPostWasPosted,
  getConnectionDb,
  getConnectionMeta,
  getPanelMessage,
  purgeAllConnectionMeta,
  purgeAllSeenPosts,
  purgeConnectionMeta,
  purgeConnectionSeenPosts,
  upsertPanelMessage,
} from "./db";
import { buildPanelEmbed, buildReviewBatches } from "./embed";
import {
  fetchConnectionAndCreateReviews,
  syncAllMonitorConnections,
} from "./fetch";
import { sendMonitorLog } from "./log_channel";
import { enqueuePost } from "./queue";
import {
  getReview,
  updateReview,
  deleteReview,
  MONITOR_POLL_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_EDIT_PREFIX,
  REVIEW_MODAL_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_SKIP_PREFIX,
  type ReviewState,
} from "./review";
import { findAllSnsLinks, snsService } from "../sns";
import type { AnySnsMetadata, SnsLink } from "../../platforms/base";
import { parseUsernameFromUrl } from "../links";
import { sendOpsAlert } from "../../utils/opsAlert";

const log = logger.child({ module: "monitor/interactions" });

export type ConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; reason: "skipped" | "timeout" | "error" };

// ---------------------------------------------------------------------------
// Existing handlers
// ---------------------------------------------------------------------------

const pollInProgress = new Set<string>();

async function handlePanelPollButton(
  interaction: ButtonInteraction,
  connectionId: string,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  client: Client,
  metadataDb: Database,
): Promise<void> {
  // Ensure poll is executed from the configured panel channel.
  if (interaction.channelId !== monitorsConfig.panel_channel_id) {
    await interaction.reply({
      content: "This button is only valid in the panel channel.",
      ephemeral: true,
    });
    return;
  }

  const connection = findConnectionById(monitorsConfig, connectionId);
  if (!connection) {
    await interaction.reply({ content: "Unknown connection.", ephemeral: true });
    return;
  }

  // Role check (optional).
  if (monitorsConfig.trigger_role_id) {
    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "Could not verify your roles.", ephemeral: true });
      return;
    }

    const roles = "cache" in member.roles ? member.roles.cache : null;
    if (!roles || !roles.has(monitorsConfig.trigger_role_id)) {
      await interaction.reply({
        content: "You don't have the required role to poll.",
        ephemeral: true,
      });
      return;
    }
  }

  // Cooldown check.
  const lastFetch = getConnectionMeta(metadataDb, connectionId);
  if (lastFetch) {
    const nextPollAt =
      lastFetch.last_fetched_at + connection.cooldown_seconds * 1000;
    if (Date.now() < nextPollAt) {
      const nextPollSec = Math.floor(nextPollAt / 1000);
      await interaction.reply({
        content: `On cooldown. Next poll available <t:${nextPollSec}:R>.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (pollInProgress.has(connectionId)) {
    await interaction.reply({
      content: "A poll is already running for this connection. Please wait.",
      ephemeral: true,
    });
    return;
  }

  pollInProgress.add(connectionId);
  try {
    await sendMonitorLog(
      client,
      monitorsConfig,
      `Poll started: \`${connectionId}\` by ${interaction.user.username}`,
    );

    await fetchConnectionAndCreateReviews(
      interaction,
      client,
      monitorsConfig,
      serverConfig,
      metadataDb,
      connectionId,
    );

    // Refresh the panel embed using latest metadata.
    const panelMessage = getPanelMessage(metadataDb, monitorsConfig.panel_channel_id);
    if (!panelMessage) return;

    const channel = await client.channels.fetch(monitorsConfig.panel_channel_id);
    if (!channel || !channel.isTextBased()) return;

    const msg = await channel.messages.fetch(panelMessage.message_id);


    const connectionsMeta = monitorsConfig.connections.map((c) => {
      const id = getConnectionId(c);
      return {
        connectionId: id,
        label: `${c.type}/${c.handle}`,
        cooldownSeconds: c.cooldown_seconds,
        lastFetch: getConnectionMeta(metadataDb, id),
      };
    });

    const embedData = buildPanelEmbed(connectionsMeta as any);
    await msg.edit(embedData);

    await sendMonitorLog(
      client,
      monitorsConfig,
      `Poll finished: \`${connectionId}\` by ${interaction.user.username}`,
    );
  } finally {
    pollInProgress.delete(connectionId);
  }
}

function buildPanelConnectionsMeta(
  monitorsConfig: MonitorsConfig,
  metadataDb: Database,
) {
  return monitorsConfig.connections.map((c) => {
    const id = getConnectionId(c);
    return {
      connectionId: id,
      label: `${c.type}/${c.handle}`,
      cooldownSeconds: c.cooldown_seconds,
      lastFetch: getConnectionMeta(metadataDb, id),
    };
  });
}

export async function refreshPanelEmbed(
  client: Client,
  monitorsConfig: MonitorsConfig,
  metadataDb: Database,
): Promise<boolean> {
  const panelMessage = getPanelMessage(metadataDb, monitorsConfig.panel_channel_id);
  if (!panelMessage) return false;

  const channel = await client.channels.fetch(monitorsConfig.panel_channel_id);
  if (!channel || !channel.isTextBased()) return false;

  const msg = await channel.messages.fetch(panelMessage.message_id);
  const connectionsMeta = buildPanelConnectionsMeta(monitorsConfig, metadataDb);
  const embedData = buildPanelEmbed(connectionsMeta as any);
  await msg.edit(embedData);
  return true;
}

async function postAndPinPanelEmbed(
  interaction: ChatInputCommandInteraction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  metadataDb: Database,
): Promise<void> {
  if (!interaction.channel || !("send" in interaction.channel)) {
    throw new Error("Cannot send in this channel.");
  }

  const connectionsMeta = buildPanelConnectionsMeta(monitorsConfig, metadataDb);
  const embedData = buildPanelEmbed(connectionsMeta as any);

  const msg = await (interaction.channel as SendableChannels).send(embedData);

  try {
    await msg.pin();
  } catch (err) {
    log.warn(err, "Failed to pin panel embed");
  }

  upsertPanelMessage(metadataDb, monitorsConfig.panel_channel_id, msg.id);
}

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
    ephemeral: true,
  });

  try {
    const confirmation = await confirmMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 30_000, // 30 seconds
    });

    if (confirmation.customId === "post_confirm_no") {
      await confirmMsg.edit({
        content: "⏭️ Skipped.",
        components: [],
      });
      return { confirmed: false, reason: "skipped" };
    }

    // User confirmed — proceed
    await confirmMsg.edit({
      content: "🔄 Posting again...",
      components: [],
    });
    return { confirmed: true };

  } catch (err) {
    await confirmMsg.edit({
      content: "⏰ Confirmation timed out — skipping post.",
      components: [],
    }).catch(() => { });

    return { confirmed: false, reason: "timeout" };
  }
}

// ---------------------------------------------------------------------------
// Review interaction handlers
// ---------------------------------------------------------------------------

function getReviewOrWarn(reviewId: string): ReviewState | null {
  const state = getReview(reviewId);
  if (!state) {
    log.warn({ reviewId }, "Review not found");
  }
  return state ?? null;
}

async function handleReviewRemove(
  interaction: StringSelectMenuInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.deferUpdate();
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();

  const removedIndices = new Set(interaction.values.map(Number));
  updateReview(reviewId, { removedIndices });

  const updatedState = getReview(reviewId)!;
  const batches = buildReviewBatches(updatedState, reviewId);

  const channel = interaction.channel;
  if (!channel) return;

  for (let i = 0; i < batches.length; i++) {
    const msgId = updatedState.messageIds[i];
    if (!msgId) continue;

    try {
      const msg = await channel.messages.fetch(msgId);
      const editOptions = {
        flags: MessageFlags.IsComponentsV2,
        components: batches[i].components as any,
        content: null,
        embeds: [],
      } as unknown as MessageEditOptions;

      await msg.edit(editOptions);
    } catch (err) {
      log.warn({ err, msgId }, "Failed to update review message");
    }
  }
}

async function handleReviewEdit(
  interaction: ButtonInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", ephemeral: true });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      ephemeral: true,
    });
    return;
  }

  const textInput = new TextInputBuilder()
    .setCustomId("content")
    .setLabel("Post text")
    .setStyle(TextInputStyle.Paragraph)
    .setValue(state.customContent ?? state.renderedContent)
    .setMaxLength(2000);

  const modal = new ModalBuilder()
    .setCustomId(`${REVIEW_MODAL_PREFIX}${reviewId}`)
    .setTitle("Edit Post Text")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
    );

  await interaction.showModal(modal);
}

async function handleReviewModalSubmit(
  interaction: ModalSubmitInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const customContent = interaction.fields.getTextInputValue("content");
  
  const currentContent = state.customContent ?? state.renderedContent;
  if (customContent === currentContent) {
    return;
  }
  
  updateReview(reviewId, { customContent });

  const updatedState = getReview(reviewId)!;
  const batches = buildReviewBatches(updatedState, reviewId);

  const channel = interaction.channel;
  if (!channel) return;

  const msgId = updatedState.messageIds[0];
  if (!msgId) return;

  try {
    const msg = await channel.messages.fetch(msgId);
    const editOptions = {
      flags: MessageFlags.IsComponentsV2,
      components: batches[0].components as any,
      content: null,
      embeds: [],
    } as unknown as MessageEditOptions;

    await msg.edit(editOptions);
  } catch (err) {
    log.warn({ err, msgId }, "Failed to update review message");
  }
}

async function handleReviewPost(
  interaction: ButtonInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", ephemeral: true });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      ephemeral: true,
    });
    return;
  }

  const filteredFiles = state.postData.files.filter(
    (_, i) => !state.removedIndices.has(i),
  );

  if (filteredFiles.length === 0 && state.postData.postLink.metadata.platform !== "twitter") {
    await interaction.reply({
      content: "No images selected. Re-add images before posting.",
      ephemeral: true,
    });
    return;
  }

  // Defer immediately
  await interaction.deferUpdate();

  const reviewChannel = interaction.channel;
  if (!reviewChannel) return;

  const lastMsgId = state.messageIds[state.messageIds.length - 1];

  // Delete overflow messages immediately
  for (let i = 0; i < state.messageIds.length - 1; i++) {
    const msgId = state.messageIds[i];
    try {
      await reviewChannel.messages.delete(msgId);
    } catch (err) {
      // Already deleted or missing
    }
  }

  if (lastMsgId) {
    try {
      const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
      await lastMsg.edit({
        components: [new TextDisplayBuilder().setContent("⏳ Posting...")] as any,
      });
    } catch (err) {
      // Ignore
    }
  }

  // ENQUEUE the actual posting
  enqueuePost(async () => {
    const filteredPostData = { ...state.postData, files: filteredFiles };
    let postedToSocials = false;
    let result;

    try {
      const channel = await interaction.client.channels.fetch(state.socialsChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        if (lastMsgId) {
          const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
          await lastMsg.edit({
            components: [new TextDisplayBuilder().setContent("❌ Failed - channel not sendable")] as any,
          });
        }
        return;
      }
      const filteredPostData = { ...state.postData, files: filteredFiles };

      const buildConnectionId = (platform: string, username: string) =>
        `${platform.replace(/-story$/, "")}:${username}`;

      const connectionId = buildConnectionId(
        state.postData.postLink.metadata.platform,
        state.postData.username
      );

      result = await sendPostToChannel(channel as SendableChannels, filteredPostData, {
        format: state.format as "inline" | "links",
        template: state.template,
        connectionDb: getConnectionDb(connectionId),
        postId: state.postData.postID,
      });

      postedToSocials = true;
    } catch (err) {
      log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
      if (lastMsgId) {
        try {
          const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
          await lastMsg.edit({
            components: [new TextDisplayBuilder().setContent("❌ Failed to post")] as any,
          });
        } catch (e) { /* ignore */ }
      }
      throw err; // Re-throw so queue knows it failed
    }

    if (!postedToSocials) {
      if (lastMsgId) {
        try {
          const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
          await lastMsg.edit({
            components: [new TextDisplayBuilder().setContent("❌ Failed to post")] as any,
          });
        } catch (e) { /* ignore */ }
      }
      return;
    }

    // Success! Update to "Posted" and schedule deletion
    deleteReview(reviewId);

    if (lastMsgId) {
      try {
        const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
        await lastMsg.edit({
          components: [new TextDisplayBuilder().setContent(`✅ Posted! https://discord.com/channels/${interaction.guildId}/${state.socialsChannelId}/${result?.messageIds[0]}`)] as any,
        });

        setTimeout(async () => {
          try {
            await reviewChannel.messages.delete(lastMsgId);
          } catch (err) {
            // Already deleted
          }
        }, 5000);

      } catch (err) {
        try {
          await reviewChannel.messages.delete(lastMsgId);
        } catch (e) { /* ignore */ }
      }
    }
  }).catch(() => {
    // Error already handled above
  });
}

async function handleReviewSkip(
  interaction: ButtonInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", ephemeral: true });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  deleteReview(reviewId);

  const reviewChannel = interaction.channel;
  if (!reviewChannel) return;

  const lastMsgId = state.messageIds[state.messageIds.length - 1];

  // 1. DELETE all overflow messages immediately, keep only last one
  for (let i = 0; i < state.messageIds.length - 1; i++) {
    const msgId = state.messageIds[i];
    try {
      await reviewChannel.messages.delete(msgId);
    } catch (err) {
      // Already deleted or missing
    }
  }

  // 2. Update last message to "Skipped"
  if (lastMsgId) {
    try {
      const lastMsg = await reviewChannel.messages.fetch(lastMsgId);
      await lastMsg.edit({
        components: [new TextDisplayBuilder().setContent("⏭️ Skipped")] as any,
      });

      // 3. Delete after 5 seconds
      setTimeout(async () => {
        try {
          await reviewChannel.messages.delete(lastMsgId);
        } catch (err) {
          // Already deleted
        }
      }, 5000);

    } catch (err) {
      // If edit fails, delete immediately
      try {
        await reviewChannel.messages.delete(lastMsgId);
      } catch (e) { /* ignore */ }
    }
  }
}

function extractConnectionInfo(link: SnsLink<AnySnsMetadata>): {
  username?: string;
  postId?: string;
  canCheckBeforeFetch: boolean
} {
  const { metadata, url } = link;

  switch (metadata.platform) {
    case "twitter":
      return {
        username: metadata.username,
        postId: metadata.id,
        canCheckBeforeFetch: true
      };

    case "tiktok":
      return {
        username: parseUsernameFromUrl(url),
        postId: metadata.videoId,
        canCheckBeforeFetch: true
      };

    case "instagram":
    case "instagram-story":
      return {
        username: metadata.username, // May be undefined
        postId: metadata.shortcode,
        canCheckBeforeFetch: false
      };

    default:
      return { username: undefined, postId: undefined, canCheckBeforeFetch: false };
  }
}

async function checkDuplicateBeforeFetch(
  connectionId: string,
  postId: string,
  monitorsConfig: MonitorsConfig,
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!isConnectionMonitored(monitorsConfig, connectionId)) return true;

  const connectionDb = getConnectionDb(connectionId);
  const check = checkIfPostWasPosted(connectionDb, postId);

  if (check.wasPosted) {
    const result = await promptRepostConfirmation(
      interaction,
      monitorsConfig.socials_channel_id,
      check.messageId
    );
    return result.confirmed;
  }
  return true;
}

async function handlePostCommand(
  interaction: ChatInputCommandInteraction,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  client: Client,
  db: Database,
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
    let finalConnectionDb: any | undefined;
    let connectionExists = false;

    const { username, postId, canCheckBeforeFetch } = extractConnectionInfo(link);

    if (canCheckBeforeFetch && username && postId) {
      finalConnectionId = `${normalizedPlatform}:${username}`;

      const confirmed = await checkDuplicateBeforeFetch(
        finalConnectionId,
        postId,
        monitorsConfig,
        interaction
      );
      if (!confirmed) return;
    }

    const postData = (await snsService(posts, async () => { }).next()).value?.[0];
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
        finalConnectionDb = getConnectionDb(finalConnectionId);
        connectionExists = true;

        const confirmed = await checkDuplicateBeforeFetch(
          finalConnectionId,
          postData.postID,
          monitorsConfig,
          interaction
        );
        if (!confirmed) return;
      }
    }

    const result = await sendPostToChannel(socialsChannel as SendableChannels, postData, {
      format: monitorsConfig.format,
      template: monitorsConfig.template,
      connectionDb: connectionExists ? finalConnectionDb : undefined,
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
        `View the post directly: ${postUrl}`
      );
      return;
    }

    const { requestBody: _body, ...safeErr } = (err as any) ?? {};
    logger.error(safeErr, "/post command failed");
    await interaction.followUp({
      content: `❌ Error: ${String(err)}`,
      ephemeral: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleInteraction(
  interaction: Interaction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  db: Database,
  monitorsConfigPath: string,
  reloadMonitorsConfig: () => MonitorsConfig,
): Promise<void> {
  try {
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      if (customId.startsWith(REVIEW_REMOVE_PREFIX)) {
        const reviewId = customId.slice(REVIEW_REMOVE_PREFIX.length);
        await handleReviewRemove(interaction, reviewId);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;
      if (customId.startsWith(REVIEW_MODAL_PREFIX)) {
        const reviewId = customId.slice(REVIEW_MODAL_PREFIX.length);
        await handleReviewModalSubmit(interaction, reviewId);
        return;
      }
    }

    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId.startsWith(MONITOR_POLL_PREFIX)) {
        const connectionId = customId.slice(MONITOR_POLL_PREFIX.length);
        await handlePanelPollButton(
          interaction,
          connectionId,
          monitorsConfig,
          serverConfig,
          client,
          db,
        );
        return;
      }

      if (customId.startsWith(REVIEW_EDIT_PREFIX)) {
        const reviewId = customId.slice(REVIEW_EDIT_PREFIX.length);
        await handleReviewEdit(interaction, reviewId);
        return;
      }

      if (customId.startsWith(REVIEW_POST_PREFIX)) {
        const reviewId = customId.slice(REVIEW_POST_PREFIX.length);
        await handleReviewPost(interaction, reviewId);
        return;
      }

      if (customId.startsWith(REVIEW_SKIP_PREFIX)) {
        const reviewId = customId.slice(REVIEW_SKIP_PREFIX.length);
        await handleReviewSkip(interaction, reviewId);
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      const cmd = interaction as ChatInputCommandInteraction;

      if (cmd.commandName === "fetch-all") {
        await cmd.deferReply({ ephemeral: true });

        if (!cmd.guildId) {
          await cmd.editReply({ content: "Must be used in a guild." });
          return;
        }

        if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await cmd.editReply({
            content: "You need Manage Server permission to use this command.",
          });
          return;
        }

        try {
          await syncAllMonitorConnections(monitorsConfig, db, {
            lastFetchedBy: cmd.user.username,
          });
          await refreshPanelEmbed(client, monitorsConfig, db);
          await sendMonitorLog(
            client,
            monitorsConfig,
            `/fetch-all completed by ${cmd.user.username}`,
          );
          await cmd.editReply({
            content:
              "Finished polling all connections (items marked as seen). Monitor panel updated.",
          });
        } catch (err) {
          log.error(err, "/fetch-all failed");
          await cmd.editReply({
            content:
              "Something went wrong while syncing. A public message was posted in this channel with details.",
          });
          if (cmd.channel?.isSendable()) {
            await sendOpsAlert(cmd.channel, "/fetch-all command failed", err);
          }
        }
        return;
      }

      if (cmd.commandName !== "monitor" && cmd.commandName !== "post") return;

      if (!cmd.guildId) {
        await cmd.reply({ content: "Must be used in a guild.", ephemeral: true });
        return;
      }

      // Commands that change config require guild admin.
      if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await cmd.reply({
          content: "You need Manage Guild permission to use this command.",
          ephemeral: true,
        });
        return;
      }

      if (cmd.commandName === "post") {
        await handlePostCommand(interaction, monitorsConfig, serverConfig, client, db);
        return;
      }

      const group = cmd.options.getSubcommandGroup(false);
      const sub = cmd.options.getSubcommand(true);

      if (group === "panel" && sub === "setup") {
        await cmd.deferReply({ ephemeral: true });

        if (cmd.channelId !== monitorsConfig.panel_channel_id) {
          await cmd.editReply({
            content:
              "Run this command in the configured panel channel (panel_channel_id).",
          });
          return;
        }

        if (await refreshPanelEmbed(client, monitorsConfig, db)) {
          await cmd.editReply({ content: "Panel embed refreshed." });
          return;
        }

        try {
          await postAndPinPanelEmbed(cmd, client, monitorsConfig, db);
          await cmd.editReply({ content: "Panel embed posted and pinned." });
        } catch {
          await cmd.editReply({ content: "Failed to post panel embed." });
        }
        return;
      }

      if (group === "panel" && sub === "refresh") {
        await cmd.deferReply({ ephemeral: true });

        if (!(await refreshPanelEmbed(client, monitorsConfig, db))) {
          await cmd.editReply({ content: "Panel embed not found. Run panel setup first." });
          return;
        }

        await cmd.editReply({ content: "Panel embed refreshed." });
        return;
      }

      if (group === "db" && sub === "purge-connection") {
        await cmd.deferReply({ ephemeral: true });

        const type = cmd.options.getString("type", true);
        const handle = cmd.options.getString("handle", true);
        const connectionId = `${type}:${handle}`;

        try {
          purgeConnectionSeenPosts(connectionId);
          purgeConnectionMeta(db, connectionId);
        } catch (err) {
          log.error({ err, connectionId }, "Failed to purge connection DB");
          await cmd.editReply({ content: "Failed to purge connection DB." });
          return;
        }

        await sendMonitorLog(
          client,
          monitorsConfig,
          `DB purged for connection: \`${connectionId}\` by ${cmd.user.username}`,
        );
        await cmd.editReply({ content: `Purged DB for \`${connectionId}\`.` });
        return;
      }

      if (group === "db" && sub === "purge-all") {
        await cmd.deferReply({ ephemeral: true });

        try {
          purgeAllSeenPosts();
          purgeAllConnectionMeta(db);
        } catch (err) {
          log.error({ err }, "Failed to purge all monitor DB state");
          await cmd.editReply({ content: "Failed to purge all monitor DB state." });
          return;
        }

        await sendMonitorLog(
          client,
          monitorsConfig,
          `DB purged for ALL connections by ${cmd.user.username}`,
        );
        await cmd.editReply({ content: "Purged DB for all connections." });
        return;
      }
    }
  } catch (err) {
    log.error(err, "Unhandled error in monitor interaction handler");
    try {
      if (interaction.isRepliable() && !interaction.replied) {
        if (!interaction.deferred) {
          await interaction.reply({ content: "An error occurred. Please try again.", ephemeral: true });
        } else {
          await interaction.followUp({ content: "An error occurred. Please try again.", ephemeral: true });
        }
      }
    } catch {
      // Ignore — interaction may have already expired
    }
  }
}


