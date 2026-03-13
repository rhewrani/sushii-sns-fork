import { describe, expect, it } from "bun:test";
import { TikTokDownloader } from "./downloader";

const dl = new TikTokDownloader();

describe("TikTokDownloader.findUrls", () => {
  it("matches a tiktok video URL", () => {
    const links = dl.findUrls(
      "dl https://www.tiktok.com/@username/video/1234567890",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata).toEqual({
      platform: "tiktok",
      videoId: "1234567890",
    });
  });

  it("matches without www", () => {
    const links = dl.findUrls(
      "dl https://tiktok.com/@username/video/1234567890",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata.videoId).toBe("1234567890");
  });

  it("finds multiple video URLs", () => {
    const links = dl.findUrls(
      "dl https://www.tiktok.com/@a/video/111 https://www.tiktok.com/@b/video/222",
    );
    expect(links).toHaveLength(2);
    expect(links[0].metadata.videoId).toBe("111");
    expect(links[1].metadata.videoId).toBe("222");
  });

  it("does not match non-TikTok URLs", () => {
    const links = dl.findUrls("dl https://x.com/user/status/123");
    expect(links).toHaveLength(0);
  });
});
