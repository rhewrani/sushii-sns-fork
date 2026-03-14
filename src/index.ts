import type { Server } from "bun";
import { Client, Events, GatewayIntentBits, Status } from "discord.js";
import { Hono } from "hono";
import config from "./config/config";
import { loadServerConfig } from "./config/server_config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import { registerSlashCommands } from "./handlers/monitor/commands";
import { loadMonitorsConfig } from "./handlers/monitor/config";
import { openDb } from "./handlers/monitor/db";
import { handleInteraction } from "./handlers/monitor/interactions";
import logger from "./logger";

const log = logger.child({ module: "bot" });

async function startHealthCheckServer(
  healthyFn: () => boolean,
): Promise<Server> {
  const app = new Hono();

  app.get("/", (c) => c.text("Hono!"));
  app.get("/v1/health", (c) => {
    if (healthyFn()) {
      return c.text("OK");
    }

    return c.text("NOT OK", 500);
  });

  return Bun.serve({
    port: 8080,
    fetch: app.fetch,
  });
}

function clientHealthy(client: Client): () => boolean {
  return () => {
    switch (client.ws.status) {
      case Status.Idle:
      case Status.Ready:
      case Status.Resuming:
      case Status.Connecting:
      case Status.Identifying:
      case Status.Reconnecting:
      case Status.WaitingForGuilds:
      case Status.Nearly:
        return true;

      case Status.Disconnected:
        return false;

      default:
        return false;
    }
  };
}

async function main(): Promise<void> {
  log.info(
    {
      ...config,
      DISCORD_TOKEN: "********",
      BD_API_TOKEN: "********",
      RAPID_API_KEY: "********",
    },
    "Starting bot with config",
  );

  const serverConfig = config.SERVER_CONFIG_PATH
    ? loadServerConfig(config.SERVER_CONFIG_PATH)
    : null;

  if (serverConfig) {
    log.info({ guilds: serverConfig.guilds.length }, "Server config loaded");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    await MessageCreateHandler(message, serverConfig);
  });

  if (config.MONITORS_CONFIG_PATH) {
    const monitorsConfig = loadMonitorsConfig(config.MONITORS_CONFIG_PATH);
    const monitorDb = openDb(config.DB_PATH);

    await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

    client.on(Events.InteractionCreate, async (interaction) => {
      await handleInteraction(
        interaction,
        client,
        monitorsConfig,
        serverConfig,
        monitorDb,
      );
    });

    log.info(
      { subscriptions: monitorsConfig.subscriptions.length },
      "Monitor feature enabled",
    );
  }

  const httpServer = await startHealthCheckServer(clientHealthy(client));
  log.info({ port: httpServer.port }, "Health check server started");

  process.on("SIGTERM", async () => {
    log.info("Received SIGTERM, shutting down...");
    await client.destroy();
    await httpServer.stop();
    log.info("bye");
  });

  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => logger.error(err));
