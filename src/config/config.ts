import * as dotenv from "dotenv";
import pino from "pino";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  LOG_LEVEL: z.string().optional().default("info"),
  DISCORD_TOKEN: z.string(),
  APPLICATION_ID: z.string(),

  BD_API_TOKEN: z.string(),
  RAPID_API_KEY: z.string(),

  CHANNEL_ID_WHITELIST: z
    .string()
    .transform((s) => s.split(",").map((s) => s.trim()))
    .default(""),

  SENTRY_DSN: z.string().optional(),

  SERVER_CONFIG_PATH: z.string().optional(),

  MONITORS_CONFIG_PATH: z.string().optional(),
  DB_PATH: z.string().optional().default("./data.db"),

  /** Discord user ID to @mention on public ops alerts (override to disable: set empty). */
  ALERT_DISCORD_USER_ID: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Temporary logger since we need the config to setup the real one
  const logger = pino();

  logger.error(
    {
      error: parsed.error.format(),
    },
    "❌ Invalid environment variables",
  );

  process.exit(1);
}

export type ConfigType = z.infer<typeof schema>;

export default parsed.data;
