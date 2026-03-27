import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../utils/discord";
import { FETCH_COOLDOWN_SECONDS } from "./config";
import type { LastFetch } from "./db";
import {
  MONITOR_FETCH_PREFIX,
  REVIEW_EDIT_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
  type ReviewState,
} from "./review";

export function buildStatusEmbed(
  igUsername: string,
  lastFetch: LastFetch | null,
): Pick<MessageCreateOptions, "flags" | "components"> {
  const now = Math.floor(Date.now() / 1000);

  let lastFetchedText: string;

  if (lastFetch) {
    const lastFetchedSec = Math.floor(lastFetch.last_fetched_at / 1000);
    lastFetchedText = `<t:${lastFetchedSec}:R> by ${lastFetch.last_fetched_by}`;
  } else {
    lastFetchedText = "Never";
  }

  const header = new TextDisplayBuilder().setContent(
    `📸 **Instagram Monitor: @${igUsername}**`,
  );

  const status = new TextDisplayBuilder().setContent(
    `**Last fetched:** ${lastFetchedText}`,
  );

  const fetchButton = new ButtonBuilder()
    .setCustomId(`${MONITOR_FETCH_PREFIX}${igUsername}`)
    .setLabel("Fetch New Posts")
    .setEmoji("📥")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(fetchButton);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [header, status, row] as MessageCreateOptions["components"],
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

  // TextDisplay header
  const headerText = state.customContent ?? state.renderedContent;
  components.push(new TextDisplayBuilder().setContent(headerText));

  // MediaGallery blocks — same cap as attachment messages
  for (let start = 0; start < state.fileNames.length; start += MAX_ATTACHMENTS_PER_MESSAGE) {
    const gallery = new MediaGalleryBuilder();
    const end = Math.min(start + MAX_ATTACHMENTS_PER_MESSAGE, state.fileNames.length);

    for (let i = start; i < end; i++) {
      const item = new MediaGalleryItemBuilder()
        .setURL(`attachment://${state.fileNames[i]}`)
        .setSpoiler(state.removedIndices.has(i));
      gallery.addItems(item);
    }

    components.push(gallery);
  }

  // Select menu to remove images (only if >1 file)
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
