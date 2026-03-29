import { StoryUnavailableError } from "../platforms/instagram-story/errors";

export function formatSnsErrorForUser(err: unknown): string {
  if (err instanceof StoryUnavailableError) {
    return err.message;
  }

  if (err instanceof AggregateError) {
    const storyErr = err.errors.find(
      (e): e is StoryUnavailableError => e instanceof StoryUnavailableError,
    );
    if (storyErr) {
      return storyErr.message;
    }
    const messages = err.errors.map((e) =>
      e instanceof Error ? e.message : String(e),
    );
    const joined = messages.join(" ");
    if (
      joined.includes("No Instagram stories found") ||
      joined.includes("Failed to fetch ig API story")
    ) {
      return (
        "That Instagram story is no longer available. Stories expire after about 24 hours, " +
        "or the link may be invalid."
      );
    }
    return `Download failed: ${messages.join("; ")}`;
  }

  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

/** True when every provider failed (AggregateError) and it is not only expired-story cases. */
export function shouldAlertOpsForSnsFailure(err: unknown): boolean {
  if (!(err instanceof AggregateError)) return false;
  return !err.errors.every((e) => e instanceof StoryUnavailableError);
}
