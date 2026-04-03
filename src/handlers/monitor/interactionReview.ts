import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import logger from "../../logger";
import { sendPostToChannel, type SendPostResult } from "../../utils/discord";
import { buildReviewBatches, buildReviewStatusEditOptions } from "./embed";
import { connectionIdFromPlatformUsername } from "./connectionId";
import { enqueuePost } from "./queue";
import type { MonitorRepository } from "./repository";
import {
  getReview,
  updateReview,
  deleteReview,
  REVIEW_MODAL_PREFIX,
  type ReviewState,
} from "./review";

const log = logger.child({ module: "monitor/interactionReview" });

async function editStatusMessage(
  channel: TextBasedChannel,
  msgId: string | undefined,
  text: string,
): Promise<void> {
  if (!msgId) return;
  try {
    const msg = await channel.messages.fetch(msgId);
    await msg.edit(buildReviewStatusEditOptions(text));
  } catch (err) {
    log.warn({ err, msgId }, "Failed to edit review status message");
  }
}

async function postReviewToSocials(
  state: ReviewState,
  reviewId: string,
  filteredFiles: ReviewState["postData"]["files"],
  interaction: ButtonInteraction,
  reviewChannel: TextBasedChannel,
  lastMsgId: string | undefined,
  monitorRepo: MonitorRepository,
): Promise<void> {
  const channel = await interaction.client.channels.fetch(state.socialsChannelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    await editStatusMessage(reviewChannel, lastMsgId, "❌ Failed - channel not sendable");
    return;
  }

  const normalizedPlatform = state.postData.postLink.metadata.platform.replace(/-story$/, "");
  const connectionId = connectionIdFromPlatformUsername(
    normalizedPlatform,
    state.postData.username,
  );
  const filteredPostData = { ...state.postData, files: filteredFiles };

  let result: SendPostResult;
  try {
    result = await sendPostToChannel(channel as SendableChannels, filteredPostData, {
      format: state.format as "inline" | "links",
      template: state.template,
      postTracking: {
        connectionId,
        postId: state.postData.postID,
        sink: monitorRepo,
      },
      ...(state.customContent != null ? { contentOverride: state.customContent } : {}),
    });
  } catch (err) {
    log.error({ err, channelId: state.socialsChannelId }, "Failed to post to socials channel");
    const msg =
      err instanceof Error && err.message.toLowerCase().includes("timed out")
        ? "❌ Timeout while posting"
        : "❌ Failed to post";
    await editStatusMessage(reviewChannel, lastMsgId, msg);
    return;
  }

  deleteReview(reviewId);

  const guildId = interaction.guildId;
  const firstId = result.messageIds[0];
  const postedLine =
    guildId && firstId
      ? `✅ Posted! https://discord.com/channels/${guildId}/${state.socialsChannelId}/${firstId}`
      : "✅ Posted! (open the socials channel to see the message.)";

  await editStatusMessage(reviewChannel, lastMsgId, postedLine);

  setTimeout(async () => {
    try {
      if (lastMsgId) await reviewChannel.messages.delete(lastMsgId);
    } catch {
      // Already deleted
    }
  }, 5000);
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

export async function handleReviewRemove(
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

export async function handleReviewEdit(
  interaction: ButtonInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      flags: MessageFlags.Ephemeral,
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

export async function handleReviewModalSubmit(
  interaction: ModalSubmitInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
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

export async function handleReviewPost(
  interaction: ButtonInteraction,
  reviewId: string,
  monitorRepo: MonitorRepository,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const filteredFiles = state.postData.files.filter(
    (_, i) => !state.removedIndices.has(i),
  );

  if (filteredFiles.length === 0 && state.postData.postLink.metadata.platform !== "twitter") {
    await interaction.reply({
      content: "No images selected. Re-add images before posting.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const reviewChannel = interaction.channel;
  if (!reviewChannel || !reviewChannel.isTextBased()) return;

  const lastMsgId = state.messageIds[state.messageIds.length - 1];

  for (let i = 0; i < state.messageIds.length - 1; i++) {
    const msgId = state.messageIds[i];
    try {
      await reviewChannel.messages.delete(msgId);
    } catch {
      // Already deleted or missing
    }
  }

  await editStatusMessage(reviewChannel, lastMsgId, "⏳ Posting...");

  enqueuePost(() =>
    postReviewToSocials(
      state,
      reviewId,
      filteredFiles,
      interaction,
      reviewChannel,
      lastMsgId,
      monitorRepo,
    ),
  );
}

export async function handleReviewSkip(
  interaction: ButtonInteraction,
  reviewId: string,
): Promise<void> {
  const state = getReviewOrWarn(reviewId);
  if (!state) {
    await interaction.reply({ content: "This review has expired.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== state.fetcherUserId) {
    await interaction.reply({
      content: "Only the person who triggered the fetch can interact.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  deleteReview(reviewId);

  const reviewChannel = interaction.channel;
  if (!reviewChannel || !reviewChannel.isTextBased()) return;

  const lastMsgId = state.messageIds[state.messageIds.length - 1];

  for (let i = 0; i < state.messageIds.length - 1; i++) {
    const msgId = state.messageIds[i];
    try {
      await reviewChannel.messages.delete(msgId);
    } catch {
      // Already deleted or missing
    }
  }

  await editStatusMessage(reviewChannel, lastMsgId, "⏭️ Skipped");

  if (lastMsgId) {
    setTimeout(async () => {
      try {
        await reviewChannel.messages.delete(lastMsgId);
      } catch {
        // Already deleted
      }
    }, 5000);
  }
}
