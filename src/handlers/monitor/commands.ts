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
    .setDescription("SNS monitor panel + connection management")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("Panel setup and refresh")
        .addSubcommand((sub) =>
          sub.setName("setup").setDescription("Post/pin the monitor panel embed in this channel"),
        )
        .addSubcommand((sub) =>
          sub.setName("refresh").setDescription("Refresh the panel embed in this channel"),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("connections")
        .setDescription("Add/remove monitored connections")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add or update a monitored connection")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("Connection type")
                .setRequired(true)
                .addChoices(
                  { name: "Instagram", value: "instagram" },
                  { name: "TikTok", value: "tiktok" },
                  { name: "Twitter", value: "twitter" },
                ),
            )
            .addStringOption((opt) =>
              opt.setName("handle").setDescription("Handle/username").setRequired(true),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("cooldown_seconds")
                .setDescription("Cooldown between polls (seconds)")
                .setRequired(true)
                .setMinValue(0),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a monitored connection")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("Connection type")
                .setRequired(true)
                .addChoices(
                  { name: "Instagram", value: "instagram" },
                  { name: "TikTok", value: "tiktok" },
                  { name: "Twitter", value: "twitter" },
                ),
            )
            .addStringOption((opt) =>
              opt.setName("handle").setDescription("Handle/username").setRequired(true),
            )
            .addBooleanOption((opt) =>
              opt
                .setName("purge_db")
                .setDescription("Also purge dedupe data for this connection")
                .setRequired(false),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("db")
        .setDescription("Purge monitor DB data")
        .addSubcommand((sub) =>
          sub
            .setName("purge-connection")
            .setDescription("Purge cooldown + seen-post data for one connection")
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("Connection type")
                .setRequired(true)
                .addChoices(
                  { name: "Instagram", value: "instagram" },
                  { name: "TikTok", value: "tiktok" },
                  { name: "Twitter", value: "twitter" },
                ),
            )
            .addStringOption((opt) =>
              opt.setName("handle").setDescription("Handle/username").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("purge-all")
            .setDescription("Purge all cooldown + seen-post data"),
        ),
    );

  const postCommand = new SlashCommandBuilder()
    .setName("post")
    .setDescription("Post a message to the monitor channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("url").setDescription("Post URL").setRequired(true),
    );

  const rest = new REST().setToken(token);

  try {
    await rest.put(Routes.applicationCommands(applicationId), {
      body: [monitorCommand.toJSON(), postCommand.toJSON()],
    });
    log.info("Slash commands registered");
  } catch (err) {
    log.error(err, "Failed to register slash commands — monitor buttons will still work but slash commands may be unavailable");
  }
}
