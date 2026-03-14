import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  DiscordAPIError,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
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
  findSubscriptionByChannel,
  findSubscriptionByUsername,
} from "./config";
import { markPostSeen, getLastFetch, getMonitorMessage, upsertMonitorMessage } from "./db";
import { buildStatusEmbed, buildReviewComponents } from "./embed";
import { fetchAndPost } from "./fetch";
import {
  getReview,
  updateReview,
  deleteReview,
  MONITOR_FETCH_PREFIX,
  MONITOR_STATUS_PREFIX,
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

async function handleStatusButton(
  interaction: ButtonInteraction,
  igUsername: string,
  monitorsConfig: MonitorsConfig,
  db: Database,
): Promise<void> {
  await interaction.deferUpdate();

  const subscription = findSubscriptionByUsername(monitorsConfig, igUsername);
  if (!subscription) {
    return;
  }

  const lastFetch = getLastFetch(db, igUsername);
  const embedData = buildStatusEmbed(
    igUsername,
    subscription.fetch_cooldown_seconds,
    lastFetch,
  );

  await interaction.message.edit(embedData);
}

async function handleMonitorEmbedCommand(
  interaction: ChatInputCommandInteraction,
  monitorsConfig: MonitorsConfig,
  db: Database,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Must be used in a guild.", ephemeral: true });
    return;
  }

  // Double-check permissions
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You need the Manage Guild permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const igUsername = interaction.options.getString("username", true);

  // Verify channel is a configured watcher for this username
  const result = findSubscriptionByChannel(
    monitorsConfig,
    interaction.channelId,
  );

  if (!result || result[0].ig_username !== igUsername) {
    await interaction.reply({
      content: `This channel is not configured as a watcher for @${igUsername}.`,
      ephemeral: true,
    });
    return;
  }

  const [subscription] = result;
  const lastFetch = getLastFetch(db, igUsername);
  const embedData = buildStatusEmbed(
    igUsername,
    subscription.fetch_cooldown_seconds,
    lastFetch,
  );

  // Check if there's an existing embed message
  const stored = getMonitorMessage(db, igUsername, interaction.channelId);

  if (stored) {
    // Try to edit existing message
    try {
      const channel = interaction.channel;
      if (channel) {
        const existingMsg = await channel.messages.fetch(stored.message_id);
        await existingMsg.edit(embedData);
        await interaction.reply({ content: "Monitor embed updated.", ephemeral: true });
        return;
      }
    } catch (err) {
      if (!(err instanceof DiscordAPIError && err.code === 10008)) {
        log.error(err, "Failed to edit existing monitor embed");
        await interaction.reply({ content: "Failed to update embed.", ephemeral: true });
        return;
      }
      // Message was deleted — fall through to post new
      log.warn({ igUsername }, "Existing monitor embed was deleted, posting new one");
    }
  }

  // Post new embed
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  if (!channel || !("send" in channel)) {
    await interaction.editReply("Cannot send in this channel.");
    return;
  }

  const msg = await (channel as SendableChannels).send(embedData);

  // Pin the message
  try {
    await msg.pin();
  } catch (err) {
    log.warn(err, "Failed to pin monitor embed");
  }

  upsertMonitorMessage(
    db,
    igUsername,
    interaction.guildId,
    interaction.channelId,
    msg.id,
  );

  await interaction.editReply("Monitor embed posted and pinned.");
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
  db: Database,
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

  if (filteredFiles.length === 0) {
    await interaction.reply({
      content: "No images selected. Re-add images before posting.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  const filteredPostData = { ...state.postData, files: filteredFiles };

  let postedToAny = false;

  for (const cfg of state.channelConfigs) {
    try {
      const channel = await interaction.client.channels.fetch(cfg.channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        log.warn({ channelId: cfg.channelId }, "Watcher channel not sendable");
        continue;
      }
      const sendable = channel as SendableChannels;

      if (state.customContent !== null) {
        // Custom content overrides the template
        if (cfg.format === "inline") {
          const attachments = filteredFiles.map((f, i) =>
            new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
          );
          const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
          for (let i = 0; i < chunks.length; i++) {
            await sendable.send({
              content: i === 0 ? state.customContent : undefined,
              files: chunks[i],
              flags: MessageFlags.SuppressEmbeds,
            });
          }
        } else {
          // links format: upload attachments first to get CDN URLs, then combine
          // custom text + CDN URLs into message(s) (same as buildLinksFormatMessages)
          const attachmentMsgs = chunkArray(
            filteredFiles.map((f, i) =>
              new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
            ),
            MAX_ATTACHMENTS_PER_MESSAGE,
          );
          const cdnUrls: string[] = [];
          for (const chunk of attachmentMsgs) {
            const sent = await sendable.send({ files: chunk });
            for (const att of sent.attachments.values()) {
              cdnUrls.push(att.url);
            }
          }
          for (const chunk of itemsToMessageContents(state.customContent, cdnUrls)) {
            await sendable.send({ content: chunk, flags: MessageFlags.SuppressEmbeds });
          }
        }
      } else if (cfg.format === "inline") {
        const content = buildInlineFormatContent(cfg.template, filteredPostData);
        const attachments = filteredFiles.map((f, i) =>
          new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
        );
        const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
        for (let i = 0; i < chunks.length; i++) {
          await sendable.send({
            content: i === 0 ? content : undefined,
            files: chunks[i],
            flags: MessageFlags.SuppressEmbeds,
          });
        }
      } else {
        // links format
        const attachments = filteredFiles.map((f, i) =>
          new AttachmentBuilder(f.buffer).setName(`media-${i}.${f.ext}`),
        );
        const chunks = chunkArray(attachments, MAX_ATTACHMENTS_PER_MESSAGE);
        const cdnUrls: string[] = [];
        for (const chunk of chunks) {
          const sent = await sendable.send({ files: chunk });
          for (const att of sent.attachments.values()) {
            cdnUrls.push(att.url);
          }
        }
        const textMsgs = buildLinksFormatMessages(cfg.template, filteredPostData, cdnUrls);
        for (const msg of textMsgs) {
          await sendable.send(msg);
        }
      }

      postedToAny = true;
    } catch (err) {
      log.error({ err, channelId: cfg.channelId }, "Failed to post to watcher channel");
    }
  }

  if (!postedToAny) {
    await interaction.followUp({ content: "Failed to post to any channel. Please try again.", ephemeral: true });
    return;
  }

  markPostSeen(db, state.igUsername, state.postData.postID);
  deleteReview(reviewId);

  await interaction.message.edit({
    components: [new TextDisplayBuilder().setContent("✅ Posted")] as any,
  });
}

async function handleReviewSkip(
  interaction: ButtonInteraction,
  reviewId: string,
  db: Database,
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

  markPostSeen(db, state.igUsername, state.postData.postID);
  deleteReview(reviewId);

  await interaction.message.edit({
    components: [new TextDisplayBuilder().setContent("⏭️ Skipped")] as any,
  });
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

      if (customId.startsWith(MONITOR_FETCH_PREFIX)) {
        await fetchAndPost(interaction, client, monitorsConfig, serverConfig, db);
        return;
      }

      if (customId.startsWith(MONITOR_STATUS_PREFIX)) {
        const igUsername = customId.slice(MONITOR_STATUS_PREFIX.length);
        await handleStatusButton(interaction, igUsername, monitorsConfig, db);
        return;
      }

      if (customId.startsWith(REVIEW_EDIT_PREFIX)) {
        const reviewId = customId.slice(REVIEW_EDIT_PREFIX.length);
        await handleReviewEdit(interaction, reviewId);
        return;
      }

      if (customId.startsWith(REVIEW_POST_PREFIX)) {
        const reviewId = customId.slice(REVIEW_POST_PREFIX.length);
        await handleReviewPost(interaction, reviewId, db);
        return;
      }

      if (customId.startsWith(REVIEW_SKIP_PREFIX)) {
        const reviewId = customId.slice(REVIEW_SKIP_PREFIX.length);
        await handleReviewSkip(interaction, reviewId, db);
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName === "monitor" &&
        interaction.options.getSubcommand() === "embed"
      ) {
        await handleMonitorEmbedCommand(interaction, monitorsConfig, db);
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
