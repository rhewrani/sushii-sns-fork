const BOT_USER_AGENT =
  "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns";

export function fetchWithHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Seed from existing headers (handles both Request objects and plain init headers)
  const existing = input instanceof Request ? input.headers : init?.headers;
  const headers = new Headers(existing);
  headers.set("User-Agent", BOT_USER_AGENT);

  if (input instanceof Request) {
    return fetch(new Request(input, { ...init, headers }));
  }

  return fetch(input, { ...init, headers });
}

export function getFileExtFromURL(url: string): string {
  const urlObj = new URL(url);
  const match = urlObj.pathname.match(/\.([^.]+)$/);
  return match?.[1] ?? "jpg";
}
