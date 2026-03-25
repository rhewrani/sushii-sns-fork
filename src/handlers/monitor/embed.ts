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
} from "discord.js";
import { chunkArray, MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import type { LastFetch } from "./db";
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
  /**
   * Internal deterministic ID used in button `customId`.
   * Example: `instagram:lalalalisa_m`
   */
  connectionId: string;
  /**
   * Human label shown in embed + button.
   * Example: `instagram/lalalalisa_m`
   */
  label: string;
  cooldownSeconds: number;
  lastFetch: LastFetch | null;
};

function typeToEmoji(connectionId: string): string {
  // connectionId is `${type}:${handle}`
  if (connectionId.startsWith("instagram:")) return "📸";
  if (connectionId.startsWith("tiktok:")) return "🎵";
  if (connectionId.startsWith("twitter:")) return "🐦";
  return "🔎";
}

function typeToButtonStyle(connectionId: string): ButtonStyle {
  // Discord only has a few button colors; map each platform to a distinct one.
  if (connectionId.startsWith("instagram:")) return ButtonStyle.Primary;
  if (connectionId.startsWith("tiktok:")) return ButtonStyle.Success;
  if (connectionId.startsWith("twitter:")) return ButtonStyle.Secondary;
  return ButtonStyle.Danger;
}

/**
 * Build the single “panel” embed with one poll button per connection.
 */
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

// discord.js types don't fully model Components V2 top-level components yet;
// use a typed union internally and cast at the discord.js API boundary.
type ReviewComponent =
  | TextDisplayBuilder
  | MediaGalleryBuilder
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<ButtonBuilder>;

export function buildReviewComponents(
  state: ReviewState,
  reviewId: string,
): ReviewComponent[] {
  const components: ReviewComponent[] = [];

  // Text header
  const headerText = state.customContent ?? state.renderedContent;
  components.push(new TextDisplayBuilder().setContent(headerText));

  // MediaGallery — only files attached to THIS message (first chunk, max 10).
  // Overflow images are in separate messages above and can't be referenced here.
  const galleryNames = state.fileNames.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (galleryNames.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = 0; i < galleryNames.length; i++) {
      const item = new MediaGalleryItemBuilder()
        .setURL(`attachment://${galleryNames[i]}`)
        .setSpoiler(state.removedIndices.has(i));
      gallery.addItems(item);
    }
    components.push(gallery);
  }

  // Select menu lists ALL files (including overflow) so moderator can remove any
  if (state.fileNames.length > 1) {
    const options = state.fileNames.map((name, i) => {
      const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
      return new StringSelectMenuOptionBuilder()
        .setLabel(`Image ${i + 1} (${ext})`)
        .setValue(String(i))
        .setDefault(state.removedIndices.has(i));
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${REVIEW_REMOVE_PREFIX}${reviewId}`)
      .setPlaceholder("Select images to remove (click again to undo)...")
      .setMinValues(0)
      .setMaxValues(state.fileNames.length)
      .addOptions(options);

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );
  }

  // Action buttons
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
 * Build the full message options for a Components V2 review message.
 */
export function buildReviewMessage(
  state: ReviewState,
  reviewId: string,
  files: AttachmentBuilder[],
): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    files,
    components: buildReviewComponents(state, reviewId) as MessageCreateOptions["components"],
  };
}
