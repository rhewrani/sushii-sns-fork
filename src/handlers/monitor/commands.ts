import {
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import logger from "../../logger";

const log = logger.child({ module: "monitor/commands" });

export async function registerSlashCommands(
  applicationId: string,
  token: string,
): Promise<void> {
  const monitorCommand = new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Instagram monitor commands")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("embed")
        .setDescription("Post or update the monitor status embed in this channel")
        .addStringOption((opt) =>
          opt
            .setName("username")
            .setDescription("Instagram username to monitor")
            .setRequired(true),
        ),
    );

  const rest = new REST().setToken(token);

  try {
    await rest.put(Routes.applicationCommands(applicationId), {
      body: [monitorCommand.toJSON()],
    });
    log.info("Slash commands registered");
  } catch (err) {
    log.error(err, "Failed to register slash commands — monitor buttons will still work but slash commands may be unavailable");
  }
}
