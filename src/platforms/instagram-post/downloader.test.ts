import { describe, expect, it } from "bun:test";
import { InstagramPostDownloader, extractMediaUrls } from "./downloader";
import { InstagramPostListSchema } from "./types";
import singleVideoFixture from "./fixtures/single_video.json";
import singleImageNoMediaFixture from "./fixtures/single_image_no_media.json";
import mixedCarouselFixture from "./fixtures/mixed_carousel.json";

function parseFixture(raw: unknown) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return InstagramPostListSchema.parse(arr);
}

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

const INTEGRATION = !!process.env.INTEGRATION && !!process.env.BD_API_TOKEN;

describe.if(INTEGRATION)("InstagramPostDownloader.fetchContent (integration)", () => {
  it("fetches a video post", async () => {
    const link = {
      url: "https://www.instagram.com/p/DWYdCUAkkQj/",
      metadata: { platform: "instagram" as const },
    };
    const posts = await dl.fetchContent(link);
    expect(posts).toHaveLength(1);
    expect(posts[0].files.length).toBeGreaterThan(0);
    expect(posts[0].username).toBeTruthy();
  }, 60_000);

  it("fetches a mixed carousel (images + videos), preserving order", async () => {
    const link = {
      url: "https://www.instagram.com/p/DWQzagEkWFr/",
      metadata: { platform: "instagram" as const },
    };
    const posts = await dl.fetchContent(link);
    expect(posts).toHaveLength(1);
    expect(posts[0].files.length).toBe(20);
  }, 60_000);
});

describe("extractMediaUrls — fixtures", () => {
  it("single video post: returns 1 video URL, thumbnailOnly=false", () => {
    const [post] = parseFixture(singleVideoFixture);
    const result = extractMediaUrls(post);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toInclude("instagram.com");
    expect(result.thumbnailOnly).toBe(false);
  });

  it("single image post with no media: falls back to thumbnail, thumbnailOnly=true", () => {
    const [post] = parseFixture(singleImageNoMediaFixture);
    expect(post.post_content).toHaveLength(0);
    expect(post.photos).toBeFalsy();
    expect(post.videos).toBeFalsy();
    expect(post.images).toHaveLength(0);
    const result = extractMediaUrls(post);
    expect(result.urls).toHaveLength(1);
    expect(result.thumbnailOnly).toBe(true);
  });

  it("mixed carousel: returns 20 URLs from post_content, preserving Photo+Video order, thumbnailOnly=false", () => {
    const [post] = parseFixture(mixedCarouselFixture);
    expect(post.post_content).toHaveLength(20);

    const result = extractMediaUrls(post);
    expect(result.urls).toHaveLength(20);
    expect(result.thumbnailOnly).toBe(false);

    const types = post.post_content!.map((m) => m.type);
    expect(types).toContain("Photo");
    expect(types).toContain("Video");

    for (const url of result.urls) {
      expect(url).toInclude("cdninstagram.com");
    }
  });

  it("mixed carousel: post_content takes priority over photos/videos arrays", () => {
    const [post] = parseFixture(mixedCarouselFixture);
    expect(post.photos?.length).toBe(16);
    expect(post.videos?.length).toBe(4);
    const result = extractMediaUrls(post);
    expect(result.urls).toHaveLength(20);
  });
});

describe("extractMediaUrls — fallback logic", () => {
  it("falls back to photos when post_content is empty", () => {
    const post = {
      post_content: [],
      photos: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
    };
    const result = extractMediaUrls(post as any);
    expect(result.urls).toEqual(["https://example.com/a.jpg", "https://example.com/b.jpg"]);
    expect(result.thumbnailOnly).toBe(false);
  });

  it("falls back to videos when post_content and photos are empty", () => {
    const post = { post_content: [], photos: [], videos: ["https://example.com/v.mp4"] };
    const result = extractMediaUrls(post as any);
    expect(result.urls).toEqual(["https://example.com/v.mp4"]);
    expect(result.thumbnailOnly).toBe(false);
  });

  it("falls back to images objects when post_content, photos, and videos are empty", () => {
    const post = {
      post_content: [],
      photos: null,
      videos: null,
      images: [{ id: "1", url: "https://example.com/i.jpg" }],
    };
    const result = extractMediaUrls(post as any);
    expect(result.urls).toEqual(["https://example.com/i.jpg"]);
    expect(result.thumbnailOnly).toBe(false);
  });

  it("falls back to thumbnail when all other fields are empty, thumbnailOnly=true", () => {
    const post = {
      post_content: [],
      photos: null,
      videos: null,
      images: null,
      thumbnail: "https://example.com/thumb.jpg",
    };
    const result = extractMediaUrls(post as any);
    expect(result.urls).toEqual(["https://example.com/thumb.jpg"]);
    expect(result.thumbnailOnly).toBe(true);
  });

  it("returns empty urls when nothing is populated", () => {
    const post = { post_content: [], photos: null, videos: null, images: null };
    const result = extractMediaUrls(post as any);
    expect(result.urls).toHaveLength(0);
    expect(result.thumbnailOnly).toBe(false);
  });
});
