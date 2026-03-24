import logger from "../logger";

const log = logger.child({ module: "fallback" });

export type Provider<T> = {
  name: string;
  fn: () => Promise<T>;
};

/**
 * Tries each provider in order. On failure, logs and moves to the next.
 * Throws an AggregateError if all providers fail.
 */
export async function tryWithFallbacks<T>(
  providers: Provider<T>[],
): Promise<T> {
  const errors: Error[] = [];

  for (const provider of providers) {
    try {
      log.debug({ provider: provider.name }, "Trying provider");
      const result = await provider.fn();
      log.debug({ provider: provider.name }, "Provider succeeded");
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(
        { provider: provider.name, err: error.message },
        "Provider failed, trying next",
      );
      errors.push(error);
    }
  }

  throw new AggregateError(
    errors,
    `All ${providers.length} providers failed: ${errors.map((e) => e.message).join("; ")}`,
  );
}
