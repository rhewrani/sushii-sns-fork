/**
 * Deterministic monitor connection id: normalized platform + handle/username.
 * `platform` should already be normalized (e.g. instagram-story → instagram at call site if needed).
 */
export function connectionIdFromPlatformUsername(
  normalizedPlatform: string,
  username: string,
): string {
  return `${normalizedPlatform}:${username}`;
}
