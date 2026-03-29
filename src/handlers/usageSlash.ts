import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  formatUsageAllMessage,
  formatUsageEndpointsMessage,
  formatUsageProvidersMessage,
} from "../apiUsage";
import logger from "../logger";

const log = logger.child({ module: "usageSlash" });

export async function handleUsageSlash(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command must be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need Manage Server permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const scope = interaction.options.getString("scope", true);
    let body: string;
    switch (scope) {
      case "providers":
        body = formatUsageProvidersMessage();
        break;
      case "endpoints":
        body = formatUsageEndpointsMessage();
        break;
      case "all":
        body = formatUsageAllMessage();
        break;
      default:
        body = formatUsageAllMessage();
    }

    await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
  } catch (err) {
    log.error(err, "usage slash command failed");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Could not load usage stats.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "Could not load usage stats.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // ignore
    }
  }
}
