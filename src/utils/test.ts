import { describe, it } from "bun:test";

/**
 * Use for tests that make real network/API calls.
 * Skipped by default — run with INTEGRATION=1 bun test to enable.
 *
 * @example
 * itIntegration("fetches real post", async () => { ... });
 * describeIntegration("live API", () => { itIntegration(...) });
 */
const enabled = !!process.env.INTEGRATION;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const itIntegration: typeof it = (enabled ? it : it.skip) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const describeIntegration: typeof describe = (enabled ? describe : describe.skip) as any;
