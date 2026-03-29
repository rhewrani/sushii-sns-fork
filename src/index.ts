import type { Server } from "bun";
import { Client, Events, GatewayIntentBits, Status } from "discord.js";
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import config from "./config/config";
import { loadServerConfig } from "./config/server_config";
import { MessageCreateHandler } from "./handlers/MessageCreate";
import { registerSlashCommands } from "./handlers/monitor/commands";
import { loadMonitorsConfig } from "./handlers/monitor/config";
import { openMetadataDb } from "./handlers/monitor/db";
import { handleInteraction } from "./handlers/monitor/interactions";
import { isDevMode } from "./handlers/monitor/runtime";
import logger from "./logger";

const log = logger.child({ module: "bot" });

async function startHealthCheckServer(
  client: Client,
): Promise<Server<any>> {
  const app = new Hono();
  const healthyFn = clientHealthy(client);

  app.use("*", honoLogger());

  app.get("/", (c) => c.text("Hono!"));

  app.get("/v1/health", (c) => {
    if (healthyFn()) {
      return c.text("OK");
    }
    return c.text("NOT OK", 500);
  });

  app.get("/v1/ready", (c) => {
    if (client.isReady()) {
      return c.text("Ready");
    }
    return c.text("Not Ready", 503);
  });

  app.get("/v1/uptime", (c) => {
    return c.json({
      uptime_seconds: Math.floor(process.uptime()),
      bot_uptime_ms: client.uptime,
    });
  });

  app.get("/v1/status", (c) => {
    const memory = process.memoryUsage();
    return c.json({
      status: healthyFn() ? "healthy" : "unhealthy",
      ready: client.isReady(),
      ping: client.ws.ping,
      uptime: process.uptime(),
      bot_uptime: client.uptime,
      guilds: client.guilds.cache.size,
      memory: {
        rss: `${Math.round(memory.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
      },
    });
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
  const monitorDevMode = isDevMode();
  log.info(
    {
      ...config,
      DISCORD_TOKEN: "********",
      BD_API_TOKEN: "********",
      RAPID_API_KEY: "********",
      MONITOR_DEV_MODE: monitorDevMode,
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
    await MessageCreateHandler(message);
  });

  if (config.MONITORS_CONFIG_PATH) {
    const monitorsConfigPath = config.MONITORS_CONFIG_PATH;
    let monitorsConfig = loadMonitorsConfig(monitorsConfigPath);
    const monitorDb = openMetadataDb(config.DB_PATH);
    const reloadMonitorsConfig = () => {
      monitorsConfig = loadMonitorsConfig(monitorsConfigPath);
      return monitorsConfig;
    };

    await registerSlashCommands(config.APPLICATION_ID, config.DISCORD_TOKEN);

    client.on(Events.InteractionCreate, async (interaction) => {
      await handleInteraction(
        interaction,
        client,
        monitorsConfig,
        serverConfig,
        monitorDb,
        monitorsConfigPath,
        reloadMonitorsConfig,
      );
    });

    log.info(
      { connections: monitorsConfig.connections.length },
      "Monitor feature enabled",
    );
  }

  const httpServer = await startHealthCheckServer(client);
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
