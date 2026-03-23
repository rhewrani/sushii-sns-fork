import { readFileSync } from "fs";
import { join } from "path";
import logger from "../../logger";

const log = logger.child({ module: "monitor/runtime" });

export function isDevMode(): boolean {
  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === "dev") return true;
  if (process.env.MONITOR_DEV_MODE === "1") return true;
  return Bun.argv.includes("--monitor-dev");
}

export function loadMockJson<T>(fileName: string): T {
  const path = join(process.cwd(), "mocks", "monitor", fileName);
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error({ err, path }, "Invalid monitor mock JSON");
    throw err;
  }
}
