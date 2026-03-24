import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  AttachmentBuilder,
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
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import { chunkArray, itemsToMessageContents, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import {
  buildInlineFormatContent,
  buildLinksFormatMessages,
} from "../../utils/template";
import type { MonitorsConfig } from "./config";
import {
  findConnectionById,
  getConnectionId,
  saveMonitorsConfig,
} from "./config";
import {
  getConnectionMeta,
  getPanelMessage,
  purgeAllConnectionMeta,
  purgeAllSeenPosts,
  purgeConnectionMeta,
  purgeConnectionSeenPosts,
  upsertPanelMessage,
} from "./db";
import { buildPanelEmbed, buildReviewComponents } from "./embed";
import { fetchConnectionAndCreateReviews } from "./fetch";
import { sendMonitorLog } from "./log_channel";
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

const log = logger.child({ module: "monitor/interactions" });

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

async function refreshPanelEmbed(
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

  // Only the fetcher can interact
  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.deferUpdate();
    return;
  }

  const removedIndices = new Set(interaction.values.map(Number));
  updateReview(reviewId, { removedIndices });

  const updatedState = getReview(reviewId)!;
  const components = buildReviewComponents(updatedState, reviewId);
  await interaction.update({ components: components as any });
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

  const customContent = interaction.fields.getTextInputValue("content");
  updateReview(reviewId, { customContent });

  const updatedState = getReview(reviewId)!;
  const components = buildReviewComponents(updatedState, reviewId);
  // discord.js doesn't type .update() on ModalSubmitInteraction, but the
  // Discord API supports it when the modal was triggered from a message component.
  await (interaction as any).update({ components: components as any });
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

  // Filter out removed files
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

  await interaction.deferUpdate();

  const filteredPostData = { ...state.postData, files: filteredFiles };

  let postedToSocials = false;
  try {
    const channel = await interaction.client.channels.fetch(state.socialsChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      await interaction.followUp({ content: "Socials channel not sendable.", ephemeral: true });
      return;
    }
    const sendable = channel as SendableChannels;

    if (state.customContent !== null) {
      // Custom content overrides the template.
      if (state.format === "inline") {
        const attachments = filteredFiles.map((f, i) =>
          new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
        );
        const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);

        if (chunks.length === 0) {
          // If no files (e.g., text-only Twitter post), send content directly.
          await sendable.send({
            content: state.customContent ?? undefined,
            flags: MessageFlags.SuppressEmbeds,
          });
        } else {
          for (let i = 0; i < chunks.length; i++) {
            await sendable.send({
              content: i === 0 ? state.customContent : undefined,
              files: chunks[i],
              flags: MessageFlags.SuppressEmbeds,
            });
          }
        }
      } else {
        // links format: upload attachments first to get CDN URLs, then combine
        // custom text + CDN URLs into message(s).
        const attachmentMsgs = chunkArray(
          filteredFiles.map((f, i) =>
            new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
          ),
          MAX_ATTACHMENTS_PER_MESSAGE,
        );
        const cdnUrls: string[] = [];
        for (const chunk of attachmentMsgs) {
          const sent = await sendable.send({ files: chunk, flags: MessageFlags.SuppressEmbeds });
          for (const att of sent.attachments.values()) {
            cdnUrls.push(att.url);
          }
        }

        for (const chunk of itemsToMessageContents(state.customContent, cdnUrls)) {
          await sendable.send({ content: chunk, flags: MessageFlags.SuppressEmbeds });
        }
      }
    } else if (state.format === "inline") {
      const content = buildInlineFormatContent(state.template, filteredPostData as any);
      const attachments = filteredFiles.map((f, i) =>
        new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
      );
      const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);

      if (chunks.length === 0) {
        // If no files, send rendered template text.
        await sendable.send({
          content: content,
          flags: MessageFlags.SuppressEmbeds,
        });
      } else {
        for (let i = 0; i < chunks.length; i++) {
          await sendable.send({
            content: i === 0 ? content : undefined,
            files: chunks[i],
            flags: MessageFlags.SuppressEmbeds,
          });
        }
      }
    } else {
      // links format
      const attachments = filteredFiles.map((f, i) =>
        new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
      );
      const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
      const cdnUrls: string[] = [];
      for (const chunk of chunks) {
        const sent = await sendable.send({ files: chunk, flags: MessageFlags.SuppressEmbeds });
        for (const att of sent.attachments.values()) {
          cdnUrls.push(att.url);
        }
      }

      const textMsgs = buildLinksFormatMessages(state.template, filteredPostData as any, cdnUrls);
      for (const msg of textMsgs) {
        await sendable.send(msg);
      }
    }

    postedToSocials = true;
  } catch (err) {
    log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
  }

  if (!postedToSocials) {
    await interaction.followUp({
      content: "Failed to post to socials. Please try again.",
      ephemeral: true,
    });
    return;
  }

  deleteReview(reviewId);

  await interaction.message.edit({
    components: [new TextDisplayBuilder().setContent("✅ Posted")] as any,
  });

  setTimeout(() => {
    interaction.message.delete().catch(() => {});
  }, 5000);
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

  await interaction.message.edit({
    components: [new TextDisplayBuilder().setContent("⏭️ Skipped")] as any,
  });

  setTimeout(() => {
    interaction.message.delete().catch(() => {});
  }, 5000);
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

      if (cmd.commandName !== "monitor") return;

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

      if (group === "connections" && sub === "add") {
        await cmd.deferReply({ ephemeral: true });

        const type = cmd.options.getString("type", true) as MonitorsConfig["connections"][number]["type"];
        const handle = cmd.options.getString("handle", true);
        const cooldownSeconds = cmd.options.getInteger("cooldown_seconds", true);

        const updated: MonitorsConfig = {
          ...monitorsConfig,
          connections: [...monitorsConfig.connections],
        };

        const idx = updated.connections.findIndex(
          (c) => c.type === type && c.handle === handle,
        );
        if (idx >= 0) {
          updated.connections[idx] = { ...updated.connections[idx], cooldown_seconds: cooldownSeconds };
        } else {
          updated.connections.push({ type, handle, cooldown_seconds: cooldownSeconds });
        }

        saveMonitorsConfig(monitorsConfigPath, updated);
        const reloaded = reloadMonitorsConfig();
        await sendMonitorLog(
          client,
          reloaded,
          `Connection added/updated: \`${type}:${handle}\` by ${cmd.user.username}`,
        );

        if (!(await refreshPanelEmbed(client, reloaded, db))) {
          await cmd.editReply({ content: "Connection saved. Run panel setup first to show buttons." });
          return;
        }

        await cmd.editReply({ content: "Connection added/updated and panel refreshed." });
        return;
      }

      if (group === "connections" && sub === "remove") {
        await cmd.deferReply({ ephemeral: true });

        const type = cmd.options.getString("type", true) as MonitorsConfig["connections"][number]["type"];
        const handle = cmd.options.getString("handle", true);
        const purgeDb = cmd.options.getBoolean("purge_db") ?? false;

        const updated: MonitorsConfig = {
          ...monitorsConfig,
          connections: monitorsConfig.connections.filter(
            (c) => !(c.type === type && c.handle === handle),
          ),
        };

        saveMonitorsConfig(monitorsConfigPath, updated);
        const reloaded = reloadMonitorsConfig();
        await sendMonitorLog(
          client,
          reloaded,
          `Connection removed: \`${type}:${handle}\` by ${cmd.user.username}`,
        );

        if (purgeDb) {
          const connectionId = `${type}:${handle}`;
          try {
            purgeConnectionSeenPosts(connectionId);
            purgeConnectionMeta(db, connectionId);
          } catch (err) {
            log.warn({ err, connectionId }, "Failed to purge seen_posts for connection");
          }
        }

        if (!(await refreshPanelEmbed(client, reloaded, db))) {
          await cmd.editReply({ content: "Connection removed. Run panel setup first to show buttons." });
          return;
        }

        await cmd.editReply({ content: "Connection removed and panel refreshed." });
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
