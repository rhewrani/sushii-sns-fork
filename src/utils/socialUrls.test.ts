import { describe, expect, it } from "bun:test";
import { parseUsernameFromUrl } from "./socialUrls";

describe("parseUsernameFromUrl", () => {
  it("parses TikTok @username from video URL", () => {
    expect(
      parseUsernameFromUrl("https://www.tiktok.com/@someone/video/123"),
    ).toBe("someone");
  });

  it("returns undefined for invalid URL", () => {
    expect(parseUsernameFromUrl("not-a-url")).toBeUndefined();
  });
});
