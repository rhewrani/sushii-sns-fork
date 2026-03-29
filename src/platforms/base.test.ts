import { describe, expect, it } from "bun:test";
import { platformToString } from "./base";

describe("platformToString", () => {
  it("maps twitter", () => {
    expect(platformToString("twitter")).toBe("Twitter");
  });

  it("maps instagram", () => {
    expect(platformToString("instagram")).toBe("Instagram");
  });

  it("maps instagram-story to Instagram (same label as posts)", () => {
    expect(platformToString("instagram-story")).toBe("Instagram");
  });

  it("maps tiktok", () => {
    expect(platformToString("tiktok")).toBe("TikTok");
  });
});
