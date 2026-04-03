import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import type { LastFetch } from "./repository";
import {
  MONITOR_FETCH_PREFIX,
  MONITOR_STATUS_PREFIX,
  REVIEW_EDIT_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
  type ReviewState,
} from "./review";

export function buildStatusEmbed(
  igUsername: string,
  cooldownSeconds: number,
  lastFetch: LastFetch | null,
): Pick<MessageCreateOptions, "embeds" | "components"> {
  // ... existing code unchanged ...
  const now = Math.floor(Date.now() / 1000);

  let lastFetchedValue: string;
  let nextFetchValue: string;

  if (lastFetch) {
    const lastFetchedSec = Math.floor(lastFetch.last_fetched_at / 1000);
    lastFetchedValue = `<t:${lastFetchedSec}:R> by ${lastFetch.last_fetched_by}`;

    const nextFetchSec = lastFetchedSec + cooldownSeconds;
    if (now >= nextFetchSec) {
      nextFetchValue = "Now";
    } else {
      nextFetchValue = `<t:${nextFetchSec}:R>`;
    }
  } else {
    lastFetchedValue = "Never";
    nextFetchValue = "Now";
  }

  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle(`📸 Instagram Monitor: @${igUsername}`)
    .addFields(
      { name: "Last fetched", value: lastFetchedValue, inline: true },
      { name: "Next fetch available", value: nextFetchValue, inline: true },
    );

  const fetchButton = new ButtonBuilder()
    .setCustomId(`${MONITOR_FETCH_PREFIX}${igUsername}`)
    .setLabel("Fetch New Posts")
    .setEmoji("📥")
    .setStyle(ButtonStyle.Primary);

  const statusButton = new ButtonBuilder()
    .setCustomId(`${MONITOR_STATUS_PREFIX}${igUsername}`)
    .setLabel("Status")
    .setEmoji("ℹ️")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    fetchButton,
    statusButton,
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

export type PanelConnectionMeta = {
  connectionId: string;
  label: string;
  cooldownSeconds: number;
  lastFetch: LastFetch | null;
};

function typeToEmoji(connectionId: string): string {
  if (connectionId.startsWith("instagram:")) return "📸";
  if (connectionId.startsWith("tiktok:")) return "🎵";
  if (connectionId.startsWith("twitter:")) return "🐦";
  return "🔎";
}

function typeToButtonStyle(connectionId: string): ButtonStyle {
  if (connectionId.startsWith("instagram:")) return ButtonStyle.Primary;
  if (connectionId.startsWith("tiktok:")) return ButtonStyle.Success;
  if (connectionId.startsWith("twitter:")) return ButtonStyle.Secondary;
  return ButtonStyle.Danger;
}

export function buildPanelEmbed(
  connections: PanelConnectionMeta[],
): Pick<MessageCreateOptions, "embeds" | "components"> {
  const now = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle("📡 SNS Monitor Panel")
    .setDescription("Click a Poll button to fetch the latest posts for that connection.");

  const fields = connections.map((c) => {
    let lastFetchedValue: string;
    let nextFetchValue: string;

    if (c.lastFetch) {
      const lastFetchedSec = Math.floor(c.lastFetch.last_fetched_at / 1000);
      lastFetchedValue = `<t:${lastFetchedSec}:R> by ${c.lastFetch.last_fetched_by}`;

      const nextFetchSec = lastFetchedSec + c.cooldownSeconds;
      if (now >= nextFetchSec) {
        nextFetchValue = "Now";
      } else {
        nextFetchValue = `<t:${nextFetchSec}:R>`;
      }
    } else {
      lastFetchedValue = "Never";
      nextFetchValue = "Now";
    }

    return {
      name: c.label,
      value: `Last fetched: ${lastFetchedValue}\nNext poll: ${nextFetchValue}`,
      inline: true,
    };
  });

  embed.addFields(fields);

  const buttons = connections.map((c) =>
    new ButtonBuilder()
      .setCustomId(`monitor:poll:${c.connectionId}`)
      .setLabel(c.connectionId.split(":")[1] ?? c.label)
      .setEmoji(typeToEmoji(c.connectionId))
      .setStyle(typeToButtonStyle(c.connectionId)),
  );

  const rows = chunkArray(buttons, 5).map(
    (group) => new ActionRowBuilder().addComponents(group),
  );

  return {
    embeds: [embed],
    components: rows as any,
  };
}

// ---------------------------------------------------------------------------
// Components V2 review message builders
// ---------------------------------------------------------------------------

type ReviewComponent =
  | TextDisplayBuilder
  | MediaGalleryBuilder
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<ButtonBuilder>;

/**
 * Represents one message batch in a multi-message review.
 */
export interface ReviewMessageBatch {
  files: AttachmentBuilder[];
  components: ReviewComponent[];
  isLast: boolean;
}

/**
 * Build all message batches for a review.
 * - First N-1 messages: Just images with simple headers
 * - Last message: Images + dropdown (all images) + action buttons
 */
export function buildReviewBatches(
  state: ReviewState,
  reviewId: string,
): ReviewMessageBatch[] {
  const batches: ReviewMessageBatch[] = [];
  // FIX: Get files from postData, not state directly
  const files = state.postData.files;
  const fileChunks = chunkArray(files, MAX_ATTACHMENTS_PER_MESSAGE);
  const allFileNames = state.fileNames;

  if (fileChunks.length === 0) {
    const components = buildControlComponents(state, reviewId, 0);
    batches.push({ files: [], components, isLast: true });
    return batches;
  }

  for (let i = 0; i < fileChunks.length; i++) {
    const chunk = fileChunks[i];
    const startIdx = i * MAX_ATTACHMENTS_PER_MESSAGE;
    const isLast = i === fileChunks.length - 1;
    
    const batchFileNames = chunk.map((_, idx) => allFileNames[startIdx + idx]);
    const batchAttachments = chunk.map((f, idx) => 
      new AttachmentBuilder(f.buffer).setName(batchFileNames[idx])
    );

    if (isLast) {
      // Last message: full controls
      const components = buildControlComponents(state, reviewId, startIdx);
      batches.push({ files: batchAttachments, components, isLast: true });
    } else {
      // Earlier messages: simple header + gallery only
      const components = buildSimpleComponents(state, i, startIdx);
      batches.push({ files: batchAttachments, components, isLast: false });
    }
  }

  return batches;
}

/**
 * Build components for non-last messages (images only, no controls).
 */
function buildSimpleComponents(
  state: ReviewState,
  chunkIndex: number,
  startIdx: number,
): ReviewComponent[] {
  const components: ReviewComponent[] = [];
  const allFileNames = state.fileNames;
  
  // Header text (only on first chunk)
  if (chunkIndex === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    components.push(new TextDisplayBuilder().setContent(headerText));
  } else {
    const endIdx = Math.min(startIdx + MAX_ATTACHMENTS_PER_MESSAGE, allFileNames.length);
    components.push(
      new TextDisplayBuilder().setContent(
        `📎 Images ${startIdx + 1}–${endIdx}`
      )
    );
  }
  
  // Media gallery for this chunk only
  const gallery = new MediaGalleryBuilder();
  for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i++) {
    const globalIdx = startIdx + i;
    if (globalIdx >= allFileNames.length) break;
    
    const item = new MediaGalleryItemBuilder()
      .setURL(`attachment://${allFileNames[globalIdx]}`)
      .setSpoiler(state.removedIndices.has(globalIdx));
    gallery.addItems(item);
  }
  components.push(gallery);
  
  return components;
}


/**
 * Build components for the last message (controls + dropdown for ALL images).
 * Only shows header if it's the only batch (startIdx === 0).
 */
function buildControlComponents(
  state: ReviewState,
  reviewId: string,
  startIdx: number,
): ReviewComponent[] {
  const components: ReviewComponent[] = [];
  const allFileNames = state.fileNames;

  // Only show header if this is the first batch (no previous batches)
  // If startIdx > 0, the header was already shown in the first batch
  if (startIdx === 0) {
    const headerText = state.customContent ?? state.renderedContent;
    components.push(new TextDisplayBuilder().setContent(headerText));
  }

  // Media gallery for this last chunk
  if (allFileNames.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = startIdx; i < allFileNames.length; i++) {
      const item = new MediaGalleryItemBuilder()
        .setURL(`attachment://${allFileNames[i]}`)
        .setSpoiler(state.removedIndices.has(i));
      gallery.addItems(item);
    }
    components.push(gallery);
  }

  // Select menu for ALL images (including those in previous messages)
  if (allFileNames.length > 1) {
    const options = allFileNames.map((name, i) => {
      const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
      const chunkNum = Math.floor(i / MAX_ATTACHMENTS_PER_MESSAGE) + 1;
      const label = chunkNum > 1 
        ? `Image ${i + 1} (${ext}) — batch ${chunkNum}`
        : `Image ${i + 1} (${ext})`;
      
      return new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(String(i))
        .setDefault(state.removedIndices.has(i));
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${REVIEW_REMOVE_PREFIX}${reviewId}`)
      .setPlaceholder(`Select images to remove from all ${allFileNames.length} images...`)
      .setMinValues(0)
      .setMaxValues(allFileNames.length)
      .addOptions(options);

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );
  }

  // Action buttons (Edit, Post, Skip)
  const editButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_EDIT_PREFIX}${reviewId}`)
    .setLabel("Edit Text")
    .setEmoji("✏️")
    .setStyle(ButtonStyle.Secondary);

  const postButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_POST_PREFIX}${reviewId}`)
    .setLabel("Post")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);

  const skipButton = new ButtonBuilder()
    .setCustomId(`${REVIEW_SKIP_PREFIX}${reviewId}`)
    .setLabel("Skip")
    .setEmoji("⏭️")
    .setStyle(ButtonStyle.Danger);

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      editButton,
      postButton,
      skipButton,
    ),
  );

  return components;
}

/**
 * Convert batches to MessageCreateOptions for sending.
 */
export function batchToMessageOptions(
  batch: ReviewMessageBatch,
): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    files: batch.files,
    components: batch.components as MessageCreateOptions["components"],
  };
}

/**
 * @deprecated Use buildReviewBatches instead for multi-image support.
 * Kept for backwards compatibility with single-message reviews.
 */
export function buildReviewMessage(
  state: ReviewState,
  reviewId: string,
  files: AttachmentBuilder[],
): MessageCreateOptions {
  // Fallback: build batches normally - buildReviewBatches reads from state.postData.files
  const batches = buildReviewBatches(state, reviewId);
  const lastBatch = batches[batches.length - 1];
  return batchToMessageOptions(lastBatch);
}

/**
 * Convert batches to MessageEditOptions for updating existing messages.
 * MessageEditOptions has stricter flag types than MessageCreateOptions.
 */
export function batchToEditOptions(
  batch: ReviewMessageBatch,
): MessageEditOptions {
  // Cast through unknown to handle the flag type incompatibility
  // The actual runtime values are the same, just TypeScript being strict
  return {
    flags: MessageFlags.IsComponentsV2,
    components: batch.components as any,
    // Note: files cannot be changed in edit, so we don't include them
  } as MessageEditOptions;
}

/**
 * Edit a Components V2 review message down to a single status line (posting / posted / error).
 * Must keep {@link MessageFlags.IsComponentsV2} or Discord rejects the edit and the UI can stay stuck.
 */
export function buildReviewStatusEditOptions(statusText: string): MessageEditOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [new TextDisplayBuilder().setContent(statusText)] as MessageEditOptions["components"],
    content: null,
    embeds: [],
    /** Drop review images/galleries so the status edit applies reliably */
    attachments: [],
  } as MessageEditOptions;
}
