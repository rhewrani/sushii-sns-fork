import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from "discord.js";
import type { ServerConfig } from "../../config/server_config";
import logger from "../../logger";
import type { MonitorsConfig } from "./config";
import type { MonitorRepository } from "./repository";
import { sendMonitorLog } from "./log_channel";
import {
  handlePanelPollButton,
  postAndPinPanelEmbed,
  refreshPanelEmbed,
} from "./interactionPanel";
import {
  handlePostCommand,
  promptRepostConfirmation,
  type ConfirmationResult,
} from "./interactionPost";
import {
  handleReviewEdit,
  handleReviewModalSubmit,
  handleReviewPost,
  handleReviewRemove,
  handleReviewSkip,
} from "./interactionReview";
import { syncAllMonitorConnections } from "./fetch";
import {
  REVIEW_EDIT_PREFIX,
  REVIEW_MODAL_PREFIX,
  REVIEW_POST_PREFIX,
  REVIEW_REMOVE_PREFIX,
  REVIEW_SKIP_PREFIX,
  MONITOR_POLL_PREFIX,
} from "./review";
import { sendOpsAlert } from "../../utils/opsAlert";

const log = logger.child({ module: "monitor/interactions" });

export type { ConfirmationResult };
export { promptRepostConfirmation, refreshPanelEmbed };

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleInteraction(
  interaction: Interaction,
  client: Client,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  monitorRepo: MonitorRepository,
  _monitorsConfigPath: string,
  _reloadMonitorsConfig: () => MonitorsConfig,
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
          monitorRepo,
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
        await handleReviewPost(interaction, reviewId, monitorRepo);
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
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

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
          await syncAllMonitorConnections(monitorsConfig, monitorRepo, {
            lastFetchedBy: cmd.user.username,
          });
          await refreshPanelEmbed(client, monitorsConfig, monitorRepo);
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
        await cmd.reply({ content: "Must be used in a guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (!cmd.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await cmd.reply({
          content: "You need Manage Guild permission to use this command.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (cmd.commandName === "post") {
        await handlePostCommand(interaction, monitorsConfig, serverConfig, client, monitorRepo);
        return;
      }

      const group = cmd.options.getSubcommandGroup(false);
      const sub = cmd.options.getSubcommand(true);

      if (group === "panel" && sub === "setup") {
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

        if (cmd.channelId !== monitorsConfig.panel_channel_id) {
          await cmd.editReply({
            content:
              "Run this command in the configured panel channel (panel_channel_id).",
          });
          return;
        }

        if (await refreshPanelEmbed(client, monitorsConfig, monitorRepo)) {
          await cmd.editReply({ content: "Panel embed refreshed." });
          return;
        }

        try {
          await postAndPinPanelEmbed(cmd, client, monitorsConfig, monitorRepo);
          await cmd.editReply({ content: "Panel embed posted and pinned." });
        } catch {
          await cmd.editReply({ content: "Failed to post panel embed." });
        }
        return;
      }

      if (group === "panel" && sub === "refresh") {
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

        if (!(await refreshPanelEmbed(client, monitorsConfig, monitorRepo))) {
          await cmd.editReply({ content: "Panel embed not found. Run panel setup first." });
          return;
        }

        await cmd.editReply({ content: "Panel embed refreshed." });
        return;
      }

      if (group === "db" && sub === "purge-connection") {
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

        const type = cmd.options.getString("type", true);
        const handle = cmd.options.getString("handle", true);
        const connectionId = `${type}:${handle}`;

        try {
          monitorRepo.purgeConnectionSeenPosts(connectionId);
          monitorRepo.purgeConnectionMeta(connectionId);
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
        await cmd.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          monitorRepo.purgeAllSeenPosts();
          monitorRepo.purgeAllConnectionMeta();
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
          await interaction.reply({ content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral });
        } else {
          await interaction.followUp({ content: "An error occurred. Please try again.", flags: MessageFlags.Ephemeral });
        }
      }
    } catch {
      // Ignore — interaction may have already expired
    }
  }
}
