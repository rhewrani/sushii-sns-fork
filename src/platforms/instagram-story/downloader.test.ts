import { describe, expect, it } from "bun:test";
import { InstagramStoryDownloader } from "./downloader";

const dl = new InstagramStoryDownloader();

describe("InstagramStoryDownloader.findUrls", () => {
  it("matches a profile URL at end of message", () => {
    const links = dl.findUrls("dl https://www.instagram.com/someuser/");
    expect(links).toHaveLength(1);
    expect(links[0].metadata.platform).toBe("instagram-story");
  });

  it("matches without www", () => {
    const links = dl.findUrls("dl https://instagram.com/someuser/");
    expect(links).toHaveLength(1);
  });

  it("does not match post URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/p/ABC123/");
    expect(links).toHaveLength(0);
  });

  it("does not match reel URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/reel/ABC123/");
    expect(links).toHaveLength(0);
  });

  it("does not match usernames shorter than 3 chars", () => {
    const links = dl.findUrls("dl https://www.instagram.com/ab/");
    expect(links).toHaveLength(0);
  });
});
