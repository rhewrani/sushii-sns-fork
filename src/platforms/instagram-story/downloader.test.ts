import { describe, expect, it } from "bun:test";
import { InstagramStoryDownloader } from "./downloader";

const dl = new InstagramStoryDownloader();

describe("InstagramStoryDownloader.findUrls", () => {
  it("matches a /stories/{username}/{id}/ URL", () => {
    const links = dl.findUrls(
      "dl https://www.instagram.com/stories/someuser/1234567890123456789/",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata).toEqual({
      platform: "instagram-story",
      username: "someuser",
      shortcode: "1234567890123456789",
    });
  });

  it("matches without www", () => {
    const links = dl.findUrls(
      "dl https://instagram.com/stories/other.user/9876543210/",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata.username).toBe("other.user");
    expect(links[0].metadata.shortcode).toBe("9876543210");
  });

  it("matches URL with query params", () => {
    const links = dl.findUrls(
      "dl https://www.instagram.com/stories/user_name/111/?utm_source=ig",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata.shortcode).toBe("111");
  });

  it("finds multiple story URLs in one message", () => {
    const links = dl.findUrls(
      "dl https://www.instagram.com/stories/a/1/ https://www.instagram.com/stories/b/2/",
    );
    expect(links).toHaveLength(2);
    expect(links[0].metadata.username).toBe("a");
    expect(links[1].metadata.username).toBe("b");
  });

  it("does not match bare profile URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/someuser/");
    expect(links).toHaveLength(0);
  });

  it("does not match post URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/p/ABC123/");
    expect(links).toHaveLength(0);
  });

  it("does not match reel URLs", () => {
    const links = dl.findUrls("dl https://www.instagram.com/reel/ABC123/");
    expect(links).toHaveLength(0);
  });
});
