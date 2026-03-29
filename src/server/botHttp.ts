import type { Server } from "bun";
import { Client, Status } from "discord.js";
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";

/**
 * Hono app on port 8080: health, readiness, uptime, status JSON.
 */
export async function startHealthCheckServer(
  client: Client,
): Promise<Server<undefined>> {
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

export function clientHealthy(client: Client): () => boolean {
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
