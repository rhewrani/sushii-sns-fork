/** Thrown when a story cannot be downloaded (expired, removed, or API error). */
export class StoryUnavailableError extends Error {
  override readonly name = "StoryUnavailableError";

  constructor(message: string) {
    super(message);
  }
}
