import { describe, expect, it } from "bun:test";
import { MessageFlags } from "discord.js";
import type { PostData } from "../platforms/base";
import {
  DEFAULT_INLINE_TEMPLATE,
  DEFAULT_LINKS_TEMPLATE,
  buildInlineFormatContent,
  buildLinksFormatMessages,
  buildTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "./template";

const makePostData = (overrides: Partial<PostData<{ platform: "instagram" }>> = {}): PostData<{ platform: "instagram" }> => ({
  postLink: {
    url: "https://www.instagram.com/p/ABC123/",
    metadata: { platform: "instagram" },
  },
  username: "testuser",
  postID: "ABC123",
  originalText: "hello world",
  timestamp: new Date("2026-03-13T10:00:00Z"), // KST = 2026-03-13 19:00 → 260313
  files: [],
  ...overrides,
});

const baseVars: TemplateVars = {
  dateKst: "260313",
  username: "testuser",
  postUrl: "https://www.instagram.com/p/ABC123/",
  caption: "hello world",
  platform: "Instagram",
  links: "https://cdn.example.com/1.jpg\nhttps://cdn.example.com/2.jpg",
};

// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("replaces all variables", () => {
    const result = renderTemplate(
      "{date_kst} {username} {platform}\n<{post_url}>\n{caption}\n{links}",
      baseVars,
    );
    expect(result).toBe(
      "260313 testuser Instagram\n<https://www.instagram.com/p/ABC123/>\nhello world\nhttps://cdn.example.com/1.jpg\nhttps://cdn.example.com/2.jpg",
    );
  });

  it("replaces each variable multiple times", () => {
    const result = renderTemplate("{username} {username}", baseVars);
    expect(result).toBe("testuser testuser");
  });

  it("renders empty string when links is undefined", () => {
    const vars = { ...baseVars, links: undefined };
    const result = renderTemplate("{links}", vars);
    expect(result).toBe("");
  });

  it("leaves unknown placeholders unchanged", () => {
    const result = renderTemplate("{unknown}", baseVars);
    expect(result).toBe("{unknown}");
  });
});

// ---------------------------------------------------------------------------

describe("buildTemplateVars", () => {
  it("extracts correct vars from postData", () => {
    const vars = buildTemplateVars(makePostData());
    expect(vars.username).toBe("testuser");
    expect(vars.postUrl).toBe("https://www.instagram.com/p/ABC123/");
    expect(vars.caption).toBe("hello world");
    expect(vars.platform).toBe("Instagram");
    expect(vars.dateKst).toBe("260313");
    expect(vars.links).toBeUndefined();
  });

  it("sets links when cdnUrls provided", () => {
    const vars = buildTemplateVars(makePostData(), ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"]);
    expect(vars.links).toBe("https://cdn.example.com/1.jpg\nhttps://cdn.example.com/2.jpg");
  });

  it("produces empty dateKst when timestamp is missing", () => {
    const vars = buildTemplateVars(makePostData({ timestamp: undefined }));
    expect(vars.dateKst).toBe("");
  });

  it("maps twitter platform name correctly", () => {
    const postData: PostData<{ platform: "twitter" }> = {
      postLink: { url: "https://x.com/user/status/1", metadata: { platform: "twitter" } },
      username: "twitteruser",
      postID: "1",
      originalText: "",
      files: [],
    };
    const vars = buildTemplateVars(postData);
    expect(vars.platform).toBe("Twitter");
  });
});

// ---------------------------------------------------------------------------

describe("buildLinksFormatMessages", () => {
  const cdnUrls = ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"];

  it("renders default template correctly", () => {
    const msgs = buildLinksFormatMessages(DEFAULT_LINKS_TEMPLATE, makePostData(), cdnUrls);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("260313 testuser Instagram Update");
    expect(msgs[0].content).toContain("<https://www.instagram.com/p/ABC123/>");
    expect(msgs[0].content).toContain("https://cdn.example.com/1.jpg");
    expect(msgs[0].content).toContain("https://cdn.example.com/2.jpg");
    expect(msgs[0].flags).toBe(MessageFlags.SuppressEmbeds);
  });

  it("returns single message when no {links} placeholder", () => {
    const msgs = buildLinksFormatMessages("{username} update", makePostData(), cdnUrls);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("testuser update");
  });

  it("splits into multiple messages when CDN URLs overflow 2000 chars", () => {
    const longUrl = "https://cdn.example.com/" + "a".repeat(1000);
    const manyUrls = [longUrl, longUrl, longUrl];
    const msgs = buildLinksFormatMessages("{username}\n{links}", makePostData(), manyUrls);
    expect(msgs.length).toBeGreaterThan(1);
    // Header only in first message
    expect(msgs[0].content).toContain("testuser");
    expect(msgs[1].content).not.toContain("testuser");
  });

  it("each message has SuppressEmbeds flag", () => {
    const longUrl = "https://cdn.example.com/" + "a".repeat(1000);
    const msgs = buildLinksFormatMessages("{links}", makePostData(), [longUrl, longUrl, longUrl]);
    for (const msg of msgs) {
      expect(msg.flags).toBe(MessageFlags.SuppressEmbeds);
    }
  });

  it("content is capped at 2000 chars", () => {
    const longCaption = "x".repeat(3000);
    const msgs = buildLinksFormatMessages("{caption}", makePostData({ originalText: longCaption }), []);
    expect(msgs[0].content!.length).toBeLessThanOrEqual(2000);
  });

  it("uses fullTextOverride for prefix before {links} merge (edited review text)", () => {
    const edited =
      "`260313 testuser Instagram Update`\n<https://www.instagram.com/p/ABC123/>\nEDITED_CAPTION";
    const msgs = buildLinksFormatMessages(
      DEFAULT_LINKS_TEMPLATE,
      makePostData(),
      cdnUrls,
      edited,
    );
    expect(msgs[0].content).toContain("EDITED_CAPTION");
    expect(msgs[0].content).toContain("https://cdn.example.com/1.jpg");
  });
});

// ---------------------------------------------------------------------------

describe("buildInlineFormatContent", () => {
  it("renders default inline template", () => {
    const content = buildInlineFormatContent(DEFAULT_INLINE_TEMPLATE, makePostData());
    expect(content).toContain("260313 testuser Instagram Update");
    expect(content).toContain("<https://www.instagram.com/p/ABC123/>");
    expect(content).toContain("hello world");
  });

  it("strips {links} placeholder (renders as empty string)", () => {
    const content = buildInlineFormatContent("{links}", makePostData());
    expect(content).toBe("");
  });

  it("is capped at 2000 chars", () => {
    const longCaption = "x".repeat(3000);
    const content = buildInlineFormatContent("{caption}", makePostData({ originalText: longCaption }));
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});
