import { describe, expect, it } from "bun:test";
import { TwitterDownloader } from "./downloader";

const dl = new TwitterDownloader();

describe("TwitterDownloader.findUrls", () => {
  it("matches x.com status URL", () => {
    const links = dl.findUrls("dl https://x.com/user/status/1234567890");
    expect(links).toHaveLength(1);
    expect(links[0].metadata).toEqual({
      platform: "twitter",
      username: "user",
      id: "1234567890",
    });
  });

  it("matches twitter.com status URL", () => {
    const links = dl.findUrls("dl https://twitter.com/user/status/1234567890");
    expect(links).toHaveLength(1);
    expect(links[0].metadata.id).toBe("1234567890");
  });

  it("matches www subdomain", () => {
    const links = dl.findUrls("dl https://www.x.com/user/status/1234567890");
    expect(links).toHaveLength(1);
  });

  it("matches mobile subdomain", () => {
    const links = dl.findUrls(
      "dl https://mobile.twitter.com/user/status/1234567890",
    );
    expect(links).toHaveLength(1);
  });

  it("matches URL with photo suffix", () => {
    const links = dl.findUrls(
      "dl https://x.com/user/status/1234567890/photo/1",
    );
    expect(links).toHaveLength(1);
    expect(links[0].metadata.id).toBe("1234567890");
  });

  it("matches URL with query params", () => {
    const links = dl.findUrls(
      "dl https://x.com/user/status/1234567890?s=20",
    );
    expect(links).toHaveLength(1);
  });

  it("finds multiple URLs in one message", () => {
    const links = dl.findUrls(
      "dl https://x.com/a/status/111 https://x.com/b/status/222",
    );
    expect(links).toHaveLength(2);
    expect(links[0].metadata.id).toBe("111");
    expect(links[1].metadata.id).toBe("222");
  });

  it("returns empty for non-Twitter URLs", () => {
    const links = dl.findUrls("dl https://instagram.com/p/ABC123/");
    expect(links).toHaveLength(0);
  });
});
