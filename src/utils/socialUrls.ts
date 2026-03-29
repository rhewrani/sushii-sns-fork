/**
 * Small URL parsers for social links (e.g. monitor / TikTok username extraction).
 */

export function parseUsernameFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);

    // https://www.tiktok.com/@USERNAME/video/123
    const match = urlObj.pathname.match(/^\/@([^/?#]+)/);
    return match?.[1];
  } catch {
    // URL parsing failed
  }
  return undefined;
}
