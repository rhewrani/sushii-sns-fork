import type { Database } from "bun:sqlite";
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SendableChannels,
} from "discord.js";
import logger from "../../logger";
import type { MonitorsConfig } from "./config";
import { findConnectionById, getConnectionId } from "./config";
import { getConnectionMeta, getPanelMessage, upsertPanelMessage } from "./db";
import { buildPanelEmbed } from "./embed";
import { fetchConnectionAndCreateReviews } from "./fetch";
import { sendMonitorLog } from "./log_channel";
import type { ServerConfig } from "../../config/server_config";

const log = logger.child({ module: "monitor/interactionPanel" });

// ---------------------------------------------------------------------------
// Panel poll + embed
// ---------------------------------------------------------------------------

/** One panel poll at a time (any connection). Set before calling into `fetch`. */
let panelPollInProgress = false;

export async function handlePanelPollButton(
  interaction: ButtonInteraction,
  connectionId: string,
  monitorsConfig: MonitorsConfig,
  serverConfig: ServerConfig | null,
  client: Client,
  metadataDb: Database,
): Promise<void> {
  if (interaction.channelId !== monitorsConfig.panel_channel_id) {
    await interaction.reply({
      content: "This button is only valid in the panel channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  
  if (panelPollInProgress) {
    await interaction.reply({
      content: "A fetch is already in progress. Please wait until it finishes.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (monitorsConfig.trigger_role_id) {
    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "Could not verify your roles.", flags: MessageFlags.Ephemeral });
      return;
    }

    const roles = "cache" in member.roles ? member.roles.cache : null;
    if (!roles || !roles.has(monitorsConfig.trigger_role_id)) {
      await interaction.reply({
        content: "You don't have the required role to poll.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const connection = findConnectionById(monitorsConfig, connectionId);
  if (!connection) {
    await interaction.reply({ content: "Unknown connection.", flags: MessageFlags.Ephemeral });
    return;
  }


  const lastFetch = getConnectionMeta(metadataDb, connectionId);
  if (lastFetch) {
    const nextPollAt =
      lastFetch.last_fetched_at + connection.cooldown_seconds * 1000;
    if (Date.now() < nextPollAt) {
      const nextPollSec = Math.floor(nextPollAt / 1000);
      await interaction.reply({
        content: `On cooldown. Next poll available <t:${nextPollSec}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  

  panelPollInProgress = true;
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

    await refreshPanelEmbed(client, monitorsConfig, metadataDb);

    await sendMonitorLog(
      client,
      monitorsConfig,
      `Poll finished: \`${connectionId}\` by ${interaction.user.username}`,
    );
  } finally {
    panelPollInProgress = false;
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

export async function refreshPanelEmbed(
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

export async function postAndPinPanelEmbed(
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
