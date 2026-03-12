export function fetchWithHeaders(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const headers = new Headers(args[1]?.headers);
  headers.set(
    "User-Agent",
    "Private social media downloader Discord bot: https://github.com/sushiibot/sushii-sns",
  );

  // Append to existing headers
  if (args[1]) {
    args[1].headers = {
      ...args[1].headers,
      ...headers,
    };
  } else {
    // No options provided
    args[1] = {
      headers,
    };
  }

  return fetch(...args);
}

export function getFileExtFromURL(url: string): string {
  const urlObj = new URL(url);
  const ext = urlObj.pathname.split(".").pop() ?? "jpg";

  return ext;
}
