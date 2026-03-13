import { describe, expect, it } from "bun:test";
import { InstagramPostDownloader } from "./downloader";

const dl = new InstagramPostDownloader();

describe("InstagramPostDownloader.findUrls", () => {
  it("matches /p/ post URL", () => {
    const links = dl.findUrls("dl https://www.instagram.com/p/ABC123/");
    expect(links).toHaveLength(1);
    expect(links[0].metadata.platform).toBe("instagram");
  });

  it("matches /reel/ URL", () => {
    const links = dl.findUrls("dl https://www.instagram.com/reel/ABC123/");
    expect(links).toHaveLength(1);
  });

  it("matches /reels/ URL", () => {
    const links = dl.findUrls("dl https://www.instagram.com/reels/ABC123/");
    expect(links).toHaveLength(1);
  });

  it("matches /tv/ URL", () => {
    const links = dl.findUrls("dl https://www.instagram.com/tv/ABC123/");
    expect(links).toHaveLength(1);
  });

  it("matches username/reel/ format", () => {
    const links = dl.findUrls(
      "dl https://www.instagram.com/someuser/reel/ABC123/",
    );
    expect(links).toHaveLength(1);
  });

  it("matches without www", () => {
    const links = dl.findUrls("dl https://instagram.com/p/ABC123/");
    expect(links).toHaveLength(1);
  });

  it("finds multiple post URLs", () => {
    const links = dl.findUrls(
      "dl https://www.instagram.com/p/AAA/ https://www.instagram.com/p/BBB/",
    );
    expect(links).toHaveLength(2);
  });

  it("does not match profile URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/someuser/");
    expect(links).toHaveLength(0);
  });

  it("does not match Twitter URLs", () => {
    const links = dl.findUrls("dl https://x.com/user/status/123");
    expect(links).toHaveLength(0);
  });
});
